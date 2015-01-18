var request = require('request');
var expect = require('chai').expect;
var ws = require('ws');
var filesystem = require('../../server/lib/filesystem.js');
var SyncMessage = require('../../lib/syncmessage');
var Filer = require('../../lib/filer.js');
var Buffer = Filer.Buffer;
var Path = Filer.Path;
var uuid = require( "node-uuid" );
var async = require('../../lib/async-lite.js');
var deepEqual = require('deep-equal');
var MakeDrive = require('../../client/src/index.js');
var MD5 = require('MD5');

// Ensure the client timeout restricts tests to a reasonable length
var env = require('../../server/lib/environment');
env.set('CLIENT_TIMEOUT_MS', 1000);
// Set maximum file size limit to 2000000 bytes
env.set('MAX_SYNC_SIZE_BYTES', 2000000);

// Enable a username:password for BASIC_AUTH_USERS to enable /api/get route
env.set('BASIC_AUTH_USERS', 'testusername:testpassword');
env.set('AUTHENTICATION_PROVIDER', 'passport-webmaker');

var server = require('../../server/server.js');
var app = server.app;

var serverURL = 'http://127.0.0.1:' + env.get('PORT'),
    socketURL = serverURL.replace( 'http', 'ws' );

// Mock Webmaker auth
app.post('/mocklogin/:username', function(req, res) {
  var username = req.param('username');
  if(!username){
    // Expected username.
    res.send(500);
  } else if( req.session && req.session.user && req.session.user.username === username) {
    // Already logged in.
    res.send(401);
  } else{
    // Login worked.
    req.session.user = {username: username};
    res.send(200);
  }
});

// Mock File Upload into Filer FileSystem.  URLs will look like this:
// /upload/:username/:path (where :path will contain /s)
app.post('/upload/*', function(req, res) {
  var parts = req.path.split('/');
  var username = parts[2];
  var path = '/' + parts.slice(3).join('/');

  var fileData = [];
  req.on('data', function(chunk) {
    fileData.push(new Buffer(chunk));
  });
  req.on('end', function() {
    fileData = Buffer.concat(fileData);

    var fs = filesystem.create(username);
    fs.writeFile(path, fileData, function(err) {
      if(err) {
        res.send(500, {error: err});
        return;
      }

      res.send(200);
    });

  });
});

/**
 * Misc Helpers
 */
 function run(callback) {
  if(server.ready) {
    callback();
  } else {
    server.once('ready', callback);
  }
}

function uniqueUsername() {
  return 'user' + uuid.v4();
}

function upload(username, path, contents, callback) {
  run(function() {
    request.post({
      url: serverURL + '/upload/' + username + path,
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      body: contents
    }, function(err, res) {
      expect(err).not.to.exist;
      expect(res.statusCode).to.equal(200);
      callback();
    });
  });
}

function comparePaths(a, b) {
  // If objects have a .path property, use it.
  if(a.path && b.path) {
    a = a.path;
    b = b.path;
  }
  if(a > b) return 1;
  if(a < b) return -1;
  return 0;
}


function toSyncMessage(string) {
  try {
    string = JSON.parse(string);
    string = SyncMessage.parse(string);
  } catch(e) {
    expect(e, "[Error parsing a SyncMessage to JSON]").to.not.exist;
  }
  return string;
}

/**
 * Connection Helpers
 */
function getWebsocketToken(options, callback){
  // Fail early and noisily when missing options.jar
  if(!(options && options.jar)) {
    throw('Expected options.jar');
  }

  run(function() {
    request({
      url: serverURL + '/api/sync',
      jar: options.jar,
      json: true
    }, function(err, response, body) {
      expect(err, "[Error getting a token: " + err + "]").to.not.exist;
      expect(response.statusCode, "[Error getting a token: " + response.body.message + "]").to.equal(200);

      options.token = body;
      callback(null, options);
    });
  });
}

function jar() {
  return request.jar();
}

function authenticate(options, callback){
  // If no options passed, generate a unique username and jar
  if(typeof options === 'function') {
    callback = options;
    options = {};
  }
  options.jar = options.jar || jar();
  options.username = options.username || uniqueUsername();
  options.logoutUser = function (cb) {
    // Reset the jar to kill existing auth cookie
    options.jar = jar();
    cb();
  };

  run(function() {
    request.post({
      url: serverURL + '/mocklogin/' + options.username,
      jar: options.jar
    }, function(err, res) {
      if(err) {
        return callback(err);
      }

      expect(res.statusCode).to.equal(200);
      callback(null, options);
    });
  });
}

function authenticateAndConnect(options, callback) {
  if(typeof options === 'function') {
    callback = options;
    options = {};
  }

  authenticate(options, function(err, result) {
    if(err) {
      return callback(err);
    }

    getWebsocketToken(result, function(err, result1) {
      if(err){
        return callback(err);
      }

      var testDone = result1.done;
      result1.done = function() {
        options.logoutUser(function() {
          testDone && testDone();
        });
      };

      callback(null, result1);
    });
  });
}

function authenticatedSocket(options, callback) {
  var socket;

  if(typeof options === 'function') {
    callback = options;
    options = {};
  }

  authenticateAndConnect(options, function(err, result) {
    if(err) {
      return callback(err);
    }

    socket = new ws(socketURL);
    socket.onopen = function() {
      socket.send(JSON.stringify({token: result.token}));
    };
    socket.onmessage = function(message) {
      expect(message).to.exist;
      expect(message.data).to.exist;

      var data = JSON.parse(message.data);

      expect(data.type).to.equal(SyncMessage.RESPONSE);
      expect(data.name).to.equal(SyncMessage.AUTHZ);
      callback(null, result, socket);
    };
  });
}

/**
 * Socket Helpers
 */
function decodeSocketMessage(message) {
  expect(message).to.exist;
  expect(message.data).to.exist;

  try {
    message = JSON.parse(message.data);
  } catch(err) {
    expect(err, 'Could not parse ' + message.data).not.to.exist;
  }

  return message;
}

/**
 * Sync Helpers
 */
function generateSourceList(files) {
  return files.map(function(file) {
    return {
      path: file.path,
      modified: Math.floor(Math.random() * 10000000000),
      size: file.content.length,
      type: 'FILE'
    };
  });
}

function generateChecksums(files) {
  var sourceList = generateSourceList(files);

  return sourceList.map(function(file) {
    delete file.size;
    file.checksums = [];
    return file;
  });
}

function generateDiffs(files) {
  var checksums = generateChecksums(files);

  return checksums.map(function(file, index) {
    delete file.checksums;
    file.diffs = [{data: new Buffer(files[index].content)}];
    return file;
  });
}

function generateValidationChecksums(files) {
  return files.map(function(file) {
    return {
      path: file.path,
      type: 'FILE',
      checksum: MD5(new Buffer(file.content)).toString()
    };
  });
}

function createFilesystemLayout(fs, layout, callback) {
  var paths = Object.keys(layout);
  var sh = new fs.Shell();

  function createPath(path, callback) {
    var contents = layout[path];
    // Path is either a file (string/Buffer) or empty dir (null)
    if(contents) {
      sh.mkdirp(Path.dirname(path), function(err) {
        if(err) {
          return callback(err);
        }

        fs.writeFile(path, contents, callback);
      });
    } else {
      sh.mkdirp(path, callback);
    }
  }

  async.eachSeries(paths, createPath, callback);
}

/**
 * Deletes all paths specified in paths array, or everything
 * if no paths are given.
 */
function deleteFilesystemLayout(fs, paths, callback) {
  if(!paths) {
    fs.readdir('/', function(err, entries) {
      if(err) {
        return callback(err);
      }

      entries = entries.map(function(path) {
        return Path.join('/', path);
      });

      deleteFilesystemLayout(fs, entries, callback);
    });
  } else {
    var sh = new fs.Shell();
    var rm = function(path, callback) {
      sh.rm(path, {recursive: true}, callback);
    };
    async.eachSeries(paths, rm, callback);
  }
}

// Strip .modified times from ever element in the array, or its .contents
function stripModified(listing) {
  function strip(item) {
    delete item.modified;
    if(item.contents) {
      item.contents = stripModified(item.contents);
    }
    return item;
  }

  if(Array.isArray(listing)) {
    return listing.map(strip);
  } else {
    return strip(listing);
  }
}

/**
 * Makes sure that the layout given matches what's actually
 * in the current fs.  Use ensureFilesystemContents if you
 * want to ensure file/dir contents vs. paths.
 */
function ensureFilesystemLayout(fs, layout, callback) {
  // Start by creating the layout, then compare a deep ls()
  var fs2 = new Filer.FileSystem({provider: new Filer.FileSystem.providers.Memory(uniqueUsername())});
  createFilesystemLayout(fs2, layout, function(err) {
    if(err) {
      return callback(err);
    }

    var sh = new fs.Shell();
    sh.ls('/', {recursive: true}, function(err, fsListing) {
      if(err) {
        return callback(err);
      }

      var sh2 = new fs2.Shell();
      sh2.ls('/', {recursive: true}, function(err, fs2Listing) {
        if(err) {
          return callback(err);
        }

        // Remove modified
        fsListing = stripModified(fsListing);
        fs2Listing = stripModified(fs2Listing);

        expect(deepEqual(fsListing, fs2Listing, {ignoreArrayOrder: true, compareFn: comparePaths})).to.be.true;
        callback();
      });
    });
  });
}

/**
 * Makes sure that the layout given matches what's actually
 * in the remote fs.  Use ensureFilesystemContents if you
 * want to ensure file/dir contents vs. paths.
 */
function ensureRemoteFilesystemLayout(layout, jar, callback) {
  // Start by creating the layout, then compare a deep ls()
  var layoutFS = new Filer.FileSystem({provider: new Filer.FileSystem.providers.Memory(uniqueUsername())});
  createFilesystemLayout(layoutFS, layout, function(err) {
    if(err) {
      return callback(err);
    }

    var sh = new layoutFS.Shell();
    sh.ls('/', {recursive: true}, function(err, layoutFSListing) {
      if(err) {
        return callback(err);
      }

      run(function() {
        // Now grab the remote server listing using the /j/* route
        request.get({
          url: serverURL + '/j/',
          jar: jar,
          json: true
        }, function(err, res, remoteFSListing) {
          expect(err).not.to.exist;
          expect(res.statusCode).to.equal(200);

          // Remove modified
          layoutFSListing = stripModified(layoutFSListing);
          remoteFSListing = stripModified(remoteFSListing);

          expect(deepEqual(remoteFSListing,
                           layoutFSListing,
                           {ignoreArrayOrder: true, compareFn: comparePaths})).to.be.true;
          callback(err);
        });
      });
    });
  });
}

/**
 * Ensure that the files and dirs match the layout's contents.
 * Use ensureFilesystemLayout if you want to ensure file/dir paths vs. contents.
 */
function ensureFilesystemContents(fs, layout, callback) {
  function ensureFileContents(filename, expectedContents, callback) {
    var encoding = Buffer.isBuffer(expectedContents) ? null : 'utf8';
    fs.readFile(filename, encoding, function(err, actualContents) {
      if(err) {
        return callback(err);
      }

      expect(actualContents).to.deep.equal(expectedContents);
      callback();
    });
  }

  function ensureEmptyDir(dirname, callback) {
    fs.stat(dirname, function(err, stats) {
      if(err) {
        return callback(err);
      }

      expect(stats.isDirectory()).to.be.true;

      // Also make sure it's empty
      fs.readdir(dirname, function(err, entries) {
        if(err) {
          return callback(err);
        }

        expect(entries.length).to.equal(0);
        callback();
      });
    });
  }

  function processPath(path, callback) {
    var contents = layout[path];
    if(contents) {
      ensureFileContents(path, contents, callback);
    } else {
      ensureEmptyDir(path, callback);
    }
  }

  async.eachSeries(Object.keys(layout), processPath, callback);
}

/**
 * Ensure that the remote files and dirs match the layout's contents.
 * Use ensureRemoteFilesystemLayout if you want to ensure file/dir paths vs. contents.
 */
function ensureRemoteFilesystemContents(layout, jar, callback) {
  function ensureRemoteFileContents(filename, expectedContents, callback) {
    request.get({
      url: serverURL + '/j' + filename,
      jar: jar,
      json: true
    }, function(err, res, actualContents) {
      expect(err).not.to.exist;
      expect(res.statusCode).to.equal(200);

      if(!Buffer.isBuffer(expectedContents)) {
        expectedContents = new Buffer(expectedContents);
      }

      if(!Buffer.isBuffer(actualContents)) {
        actualContents = new Buffer(actualContents);
      }

      expect(actualContents).to.deep.equal(expectedContents);
      callback(err);
    });
  }

  function ensureRemoteEmptyDir(dirname, callback) {
    request.get({
      url: serverURL + '/j' + dirname,
      jar: jar,
      json: true
    }, function(err, res, listing) {
      expect(err).not.to.exist;
      expect(res.statusCode).to.equal(200);

      expect(Array.isArray(listing)).to.be.true;
      expect(listing.length).to.equal(0);

      callback(err);
    });
  }

  function processPath(path, callback) {
    run(function() {
      var contents = layout[path];
      if(contents) {
        ensureRemoteFileContents(path, contents, callback);
      } else {
        ensureRemoteEmptyDir(path, callback);
      }
    });
  }

  async.eachSeries(Object.keys(layout), processPath, callback);
}

/**
 * Runs ensureFilesystemLayout and ensureFilesystemContents on fs
 * for given layout, making sure all paths and files/dirs match expected.
 */
function ensureFilesystem(fs, layout, callback) {
  ensureFilesystemLayout(fs, layout, function(err) {
    if(err) {
      return callback(err);
    }

    ensureFilesystemContents(fs, layout, callback);
  });
}

/**
 * Runs ensureRemoteFilesystemLayout and ensureRemoteFilesystemContents
 * for given layout, making sure all paths and files/dirs match expected.
 */
function ensureRemoteFilesystem(layout, jar, callback) {
  ensureRemoteFilesystemLayout(layout, jar, function(err) {
    if(err) {
      return callback(err);
    }
    ensureRemoteFilesystemContents(layout, jar, callback);
  });
}

/**
 * Setup a new client connection and do a downstream sync, leaving the
 * connection open. If a layout is given, we also sync that up to the server.
 * Callers should disconnect the client when done.  Callers can pass Filer
 * FileSystem options on the options object.
 */
function setupSyncClient(options, callback) {
  authenticateAndConnect(options, function(err, result) {
    if(err) {
      return callback(err);
    }

    // Make sure we have sane defaults on the options object for a filesystem
    options.provider = options.provider ||
      new Filer.FileSystem.providers.Memory(result.username + Date.now());
    options.manual = options.manual !== false;
    options.forceCreate = true;

    var fs = MakeDrive.fs(options);
    var sync = fs.sync;
    var client = {
      jar: result.jar,
      username: result.username,
      fs: fs,
      sync: sync
    };

    sync.once('connected', function onConnected() {
      sync.once('synced', function onUpstreamCompleted(message) {
        if(message === 'MakeDrive has been synced') {
          callback(null, client);
        }
      });

      if(!options.layout) {
        return;
      }

      createFilesystemLayout(fs, options.layout, function(err) {
        if(err) {
          return callback(err);
        }
        sync.request();
      });
    });

    sync.once('error', function(err) {
      // This should never happen, and if it does, we need to fail loudly.
      console.error('Unexepcted sync `error` event', err.stack);
      throw err;
    });

    sync.connect(socketURL, result.token);
  });
}

module.exports = {
  // Misc helpers
  run: run,
  app: app,
  serverURL: serverURL,
  socketURL: socketURL,
  upload: upload,
  username: uniqueUsername,
  createJar: jar,
  toSyncMessage: toSyncMessage,

  // Connection helpers
  authenticate: authenticate,
  authenticatedConnection: authenticateAndConnect,
  authenticatedSocket: authenticatedSocket,
  getWebsocketToken: getWebsocketToken,

  // Socket helpers
  decodeSocketMessage: decodeSocketMessage,

  // Filesystem helpers
  createFilesystemLayout: createFilesystemLayout,
  deleteFilesystemLayout: deleteFilesystemLayout,
  ensureFilesystemContents: ensureFilesystemContents,
  ensureFilesystemLayout: ensureFilesystemLayout,
  ensureRemoteFilesystemContents: ensureRemoteFilesystemContents,
  ensureRemoteFilesystemLayout: ensureRemoteFilesystemLayout,
  ensureFilesystem: ensureFilesystem,
  ensureRemoteFilesystem: ensureRemoteFilesystem,

  // Sync helpers
  generateSourceList: generateSourceList,
  generateChecksums: generateChecksums,
  generateDiffs: generateDiffs,
  generateValidationChecksums: generateValidationChecksums,
  setupSyncClient: setupSyncClient
};
