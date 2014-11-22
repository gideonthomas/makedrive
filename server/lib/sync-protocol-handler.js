var SyncMessage = require('../../lib/syncmessage');
var rsync = require('../../lib/rsync');
var diffHelper = require('../../lib/diff');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var getCommonPath = require('../../lib/sync-path-resolver').resolve;
var SyncLock = require('./sync-lock.js');
var redis = require('../redis-clients.js');
var log = require('./logger.js');
var Constants = require('../../lib/constants.js');
var ServerStates = Constants.server.states;
var rsyncOptions = Constants.rsyncDefaults;
var States = Constants.server.states;

var env = require('./environment.js');
var MAX_SYNC_SIZE_BYTES = env.get('MAX_SYNC_SIZE_BYTES') || Math.Infinity;


function SyncProtocolHandler(client) {
  EventEmitter.call(this);
  this.client = client;
}
util.inherits(SyncProtocolHandler, EventEmitter);

module.exports = SyncProtocolHandler;

/**
 * Common and utility methods
 */

// We hold a circular reference to the client instance, but break
// it when SyncProtocolHandler.close() is called. This is just an
// assertion to make sure we don't call things out of order.
function ensureClient(client) {
  var err;

  if(!client) {
    // Likely close() was called and now another step is happening
    // when it shouldn't. Create and log an error, so we get a stack
    // and can see why it happened.
    err = new Error('expected this.client to exist');
    log.error(err);
  }

  // If we're in an unexpected state for syncing (i.e., not a sync step), log that
  switch(client.state) {
    case ServerStates.CREATED:
    case ServerStates.CLOSED:
    case ServerStates.CLOSING:
    case ServerStates.CONNECTING:
    case ServerStates.ERROR:
      log.warn({client: client}, 'Unexpected client state for sync protocol handling: %s', client.state);
      break;
  }

  return client;
}

function findPathIndexinArray(array, path) {
  var index;

  for(i = 0; i < array.length; i++) {
    if(array[i].path === path) {
      index = i;
      i = array.length + 1;
    }
  }

  return index;
}

SyncProtocolHandler.prototype.handleMessage = function(message) {
  var client = ensureClient(this.client);

  if(message.is.request) {
    log.debug({syncMessage: message, client: client}, 'Received sync protocol Request message');
    this.handleRequest(message);
  } else if(message.is.response) {
    log.debug({syncMessage: message, client: client}, 'Received sync protocol Response message');
    this.handleResponse(message);
  } else {
    log.warn({client: client, syncMessage: message}, 'Invalid sync message type');
    client.sendMessage(SyncProtocolHandler.error.type);
  }
};

// Close and finalize the sync session
SyncProtocolHandler.prototype.close = function(callback) {
  var self = this;

  // We may or may not be able to cleanly close. If we can't yet
  // we wait on the closable event. See the rsync.patch step.
  self.client.state = States.CLOSING;

  // If we're still holding a valid lock, release it first.
  function maybeReleaseLock() {
    var lock = self.client.lock;

    function done(err) {
      log.debug({client: self.client}, 'Closed client sync handler');
      self.client.lock = null;
      self.client = null;
      callback(err);
    }

    // No lock
    if(!lock) {
      return done();
    }
    // Lock reference, but it's already unlocked
    if(lock.unlocked) {
      return done();
    }
    // Holding lock, release it
    lock.release(function(err) {
      if(err) {
        log.error({err: err, client: self.client}, 'Error releasing sync lock');
        return done(err);
      }
      done();
    });
  }

  // Wait on the client to become closable, if not already (see patch step).
  if(self.client.closable) {
    maybeReleaseLock();
  } else {
    self.once('closable', maybeReleaseLock);
  }
};

// If this client was in the process of a downstream sync, we
// want to reactivate it with a path that is the common ancestor
// of the path originally being synced, and the path that was just
// updated in the upstream sync.
SyncProtocolHandler.prototype.restartDownstream = function(path) {
  var client = ensureClient(this.client);

  if(!client.downstreamInterrupted) {
    log.warn({client: client}, 'Unexpected call to restartDownstream()');
    return;
  }

  delete client.downstreamInterrupted;
  client.state = States.OUT_OF_DATE;
  client.path = getCommonPath(path, client.path);

  rsync.sourceList(client.fs, client.path, rsyncOptions, function(err, srcList) {
    var response;

    if(err) {
      log.error({err: err, client: client}, 'rsync.sourceList error');
      response = SyncMessage.error.srclist;
    } else {
      response = SyncMessage.request.chksum;
      response.content = {srcList: srcList, path: client.path};
    }

    client.sendMessage(response);
  });
};

// When this client goes out of sync (i.e., another client for the same
// user has finished an upstream sync).
SyncProtocolHandler.prototype.sendOutOfDate = function(syncMessage) {
  var client = ensureClient(this.client);

  client.state = States.OUT_OF_DATE;
  client.path = syncMessage.content.path;
  client.sendMessage(syncMessage);
};

SyncProtocolHandler.error = {
  get type() {
    var message = SyncMessage.error.impl;
    message.content = {error: 'The Sync message cannot be handled by the server'};
    return message;
  },
  get request() {
    var message = SyncMessage.error.impl;
    message.content = {error: 'Request cannot be processed'};
    return message;
  },
  get response() {
    var message = SyncMessage.error.impl;
    message.content = {error: 'The resource sent as a response cannot be processed'};
    return message;
  }
};

SyncProtocolHandler.prototype.handleRequest = function(message) {
  var client = ensureClient(this.client);

  if(message.is.reset && !client.is.downstreaming) {
    this.handleUpstreamReset(message);
  } else if(message.is.diffs) {
    this.handleDiffRequest(message);
  } else if(message.is.sync && !client.is.downstreaming) {
    this.handleSyncInitRequest(message);
  } else if(message.is.chksum && client.is.chksum) {
    this.handleChecksumRequest(message);
  } else {
    log.warn({syncMessage: message, client: client}, 'Unable to handle request at this time.');
    client.sendMessage(SyncProtocolHandler.error.request);
  }
};

SyncProtocolHandler.prototype.handleResponse = function(message) {
  var client = ensureClient(this.client);

  if (message.is.reset) {
    this.handleDownstreamReset(message);
  } else if(message.is.authz) {
    this.handleFullDownstream(message);
  } else if(message.is.diffs && client.is.patch) {
    this.handleDiffResponse(message);
  } else if(message.is.patch) {
    this.handlePatchResponse(message);
  } else if(message.is.root && client.is.downstreaming) {
    this.handleRootResponse(message);
  } else {
    log.warn({syncMessage: message, client: client}, 'Unable to handle response at this time.');
    client.sendMessage(SyncProtocolHandler.error.response);
  }
};


/**
 * Upstream Sync Steps
 */

// Most upstream sync steps require a lock to be held.
// It's a bug if we get into one of these steps without the lock.
function ensureLock(client) {
  var lock = client.lock;
  if(!(lock && !('unlocked' in lock))) {
    // Create an error so we get a stack, too.
    var err = new Error('Attempted sync step without lock.');
    log.error({client: client, err: err}, 'Client should own lock but does not.');
    return false;
  }
  return true;
}

function releaseLock(client) {
  client.lock.removeAllListeners();
  client.lock = null;
  client.state = States.LISTENING;

  // Figure out how long this sync was active
  var startTime = client._syncStarted;
  delete client._syncStarted;
  return Date.now() - startTime;
}

SyncProtocolHandler.prototype.handleSyncInitRequest = function(message) {
  var client = ensureClient(this.client);
  if(!client) {
    return;
  }

  if(!message.content || !message.content.path) {
    log.warn({client: client, syncMessage: message}, 'Missing content.path expected by handleSyncInitRequest()');
    return client.sendMessage(SyncMessage.error.content, true);
  }

  SyncLock.request(client, function(err, lock) {
    var response;

    if(err) {
      log.error({err: err, client: client}, 'SyncLock.request() error');
      response = SyncMessage.error.impl;
    } else {
      if(lock) {
        log.debug({client: client, syncLock: lock}, 'Lock request successful, lock acquired.');

        lock.once('unlocked', function() {
          log.debug({client: client, syncLock: lock}, 'Lock unlocked');
          releaseLock(client);

          client.sendMessage(SyncMessage.error.interrupted);
        });

        client.lock = lock;
        client.state = States.CHKSUM;
        client.path = message.content.path;

        // Track the length of time this sync takes
        client._syncStarted = Date.now();

        response = SyncMessage.response.sync;
        response.content = {path: message.content.path};
      } else {
        log.debug({client: client}, 'Lock request unsuccessful, lock denied.');
        response = SyncMessage.error.locked;
        response.content = {error: 'Sync already in progress.'};
      }
    }

    client.sendMessage(response);
  });
};

// Returns true if file sizes are all within limit, false if not.
// The client's lock is released, and an error sent to client in
// the false case.
function checkFileSizeLimit(client, srcList) {
  function maxSizeExceeded() {
    client.lock.release(function(err) {
      if(err) {
        log.error({err: err, client: client}, 'Error releasing sync lock');
      }

      releaseLock(client);

      client.sendMessage(SyncMessage.error.maxsizeExceeded);
    });
  }

  for (var key in srcList) {
    if(srcList.hasOwnProperty(key)) {
      var obj = srcList[key];
      for (var prop in obj) {
        if(obj.hasOwnProperty(prop) && prop === 'size') {
          if(obj.size > MAX_SYNC_SIZE_BYTES) {
            // Fail this sync, contains a file that is too large.
            log.warn({client: client},
                     'Client tried to exceed file sync size limit: file was %s bytes, limit is %s',
                     obj.size, MAX_SYNC_SIZE_BYTES);
            maxSizeExceeded();
            return false;
          }
        }
      }
    }
  }

  return true;
}

SyncProtocolHandler.prototype.handleChecksumRequest = function(message) {
  var client = ensureClient(this.client);
  if(!client) {
    return;
  }
  if(!ensureLock(client)) {
    return;
  }

  if(!message.content || !message.content.srcList) {
    log.warn({client: client, syncMessage: message}, 'Missing content.srcList expected by handleChecksumRequest');
    return client.sendMessage(SyncMessage.error.content);
  }

  var srcList = message.content.srcList;

  // Enforce sync file size limits (if set in .env)
  if(!checkFileSizeLimit(client, srcList)) {
    return;
  }

  rsync.checksums(client.fs, client.path, srcList, rsyncOptions, function(err, checksums) {
    var response;

    if(err) {
      log.error({err: err, client: client}, 'rsync.checksums() error');
      client.lock.release(function(err) {
        if(err) {
          log.error({err: err, client: client}, 'Error releasing sync lock');
        }

        releaseLock(client);

        response = SyncMessage.error.chksum;
        client.sendMessage(response);
      });
    } else {
      response = SyncMessage.request.diffs;
      response.content = {checksums: checksums};
      client.state = States.PATCH;

      client.sendMessage(response);
    }
  });
};

// Broadcast an out-of-date message to the all clients for a given user
// other than the active sync client after an upstream sync process has completed.
// Also, if any downstream syncs were interrupted during this upstream sync,
// they will be retriggered when the message is received.
SyncProtocolHandler.prototype.broadcastUpdate = function(response) {
  var client = ensureClient(this.client);
  if(!client) {
    return;
  }

  // Send a message indicating the username and client that just updated,
  // as well as the default SyncMessage to broadcast. All other connected
  // clients for that username will need to sync (downstream) to get the
  // new updates.
  var msg = {
    username: client.username,
    id: client.id,
    syncMessage: {
      type: response.type,
      name: response.name,
      content: response.content
    }
  };

  log.debug({client: client, syncMessage: msg.syncMessage}, 'Broadcasting out-of-date');
  redis.publish(Constants.server.syncChannel, JSON.stringify(msg));
};

// End a completed sync for a client
SyncProtocolHandler.prototype.end = function(patchResponse) {
  var self = this;
  var client = ensureClient(this.client);
  if(!client) {
    return;
  }
  if(!ensureLock(client)) {
    return;
  }

  // Broadcast to (any) other clients for this username that there are changes
  rsync.sourceList(client.fs, client.path, rsyncOptions, function(err, srcList) {
    var response;

    if(err) {
      log.error({err: err, client: client}, 'rsync.sourceList error');
      response = SyncMessage.error.srclist;
    } else {
      response = SyncMessage.request.chksum;
      response.content = {srcList: srcList, path: client.path};
    }

    client.lock.release(function(err) {
      if(err) {
        log.error({err: err, client: client}, 'Error releasing lock');
      }

      var duration = releaseLock(client);
      var info = client.info();
      if(info) {
        info.upstreamSyncs++;
      }
      log.info({client: client}, 'Completed upstream sync to server in %s ms.', duration);

      client.sendMessage(patchResponse);

      // Also let all other connected clients for this uesr know that
      // they are now out of date, and need to do a downstream sync.
      self.broadcastUpdate(response);
    });
  });
};

SyncProtocolHandler.prototype.handleUpstreamReset = function() {
  var client = ensureClient(this.client);
  if(!client) {
    return;
  }
  if(!ensureLock(client)) {
    return;
  }

  client.lock.release(function(err) {
    if(err) {
      log.error({err: err, client: client}, 'Error releasing lock');
    }

    releaseLock(client);

    client.sendMessage(SyncMessage.response.reset);
  });
};

SyncProtocolHandler.prototype.handleDiffResponse = function(message) {
  var sync = this;
  var client = ensureClient(this.client);
  if(!client) {
    return;
  }
  if(!ensureLock(client)) {
    return;
  }

  if(!message.content || !message.content.diffs) {
    log.warn({client: client, syncMessage: message}, 'Missing content.diffs expected by handleDiffResponse');
    return client.sendMessage(SyncMessage.error.content);
  }

  var diffs = diffHelper.deserialize(message.content.diffs);
  client.state = States.LISTENING;

  // Called when the client is closable again
  function closable() {
    client.closable = true;
    sync.emit('closable');
  }

  // Flag that changes are being made to the filesystem,
  // preventing actions that could interrupt this process
  // and corrupt data.
  try {
    // Block attempts to stop this sync until the patch completes.
    client.closable = false;

    rsync.patch(client.fs, client.path, diffs, rsyncOptions, function(err, paths) {
      var response;

      if(err) {
        log.error({err: err, client: client}, 'rsync.patch() error');
        client.lock.release(function(err) {
          if(err) {
            log.error({err: err, client: client}, 'Error releasing sync lock');
          }

          releaseLock(client);

          response = SyncMessage.error.patch;
          response.content = paths;
          client.sendMessage(response);

          closable();
        });
      } else {
        response = SyncMessage.response.patch;
        response.content = {syncedPaths: paths.synced};
        sync.end(response);
        closable();
      }
    });
  } catch(e) {
    // Handle rsync failing badly on a patch step
    // TODO: https://github.com/mozilla/makedrive/issues/31
    log.error({err: e, client: client}, 'rsync.patch() error');
  }
};


/**
 * Downstream Sync Steps
 */
SyncProtocolHandler.prototype.handleFullDownstream = function(message) {
  var client = ensureClient(this.client);
  var fs = client.fs;

  // N/I
  var syncs = getListOfSyncs(client.fs);

  // Nothing in the filesystem, so nothing to sync
  if(!syncs.length) {
    return;
  }

  client.outOfDate = syncs;
  client.currentDownstream = [];

  // For each path in the filesystem, generate the source list and
  // trigger a downstream sync
  syncs.forEach(function(syncInfo) {
    var path = syncInfo.path;
    var response;

    rsync.sourceList(fs, path, rsyncOptions, function(err, sourceList) {
      var syncInfoCopy = {};

      if(err) {
        log.error({err: err, client: client}, 'rsync.sourceList() error for ' + syncs[0].paths);
        // N/I
        client.delaySync(path);
        response = SyncMessage.error.sourceList;
      } else {
        response = SyncMessage.request.checksums;
        response.content = { path: path, sourceList: sourceList };

        // Make a copy so that we don't store the sync times in the
        // list of paths that need to be eventually synced
        Object.keys(syncInfo).forEach(function(key) {
          syncInfoCopy[key] = syncInfo[key];
        });

        syncInfoCopy._syncStarted = Date.now();
        client.currentDownstream.push(syncInfoCopy);
      }

      client.sendMessage(response);
    });
  });
};

SyncProtocolHandler.prototype.handleDiffRequest = function(message) {
  var client = ensureClient(this.client);
  var response;
  var path;
  var checksums;

  if(!client) {
    return;
  }

  if(message.invalidContent(['checksums'])) {
    log.warn({client: client, syncMessage: message}, 'Missing content.checksums in handleDiffRequest()');
    return client.sendMessage(SyncMessage.error.content);
  }

  path = message.content.path;

  // We reject downstream sync SyncMessages unless
  // no upstream sync for that path is in progress.
  SyncLock.isUserLocked(client.username, path, function(err, locked) {
    if(err) {
      log.error({err: err, client: client}, 'Error trying to look-up lock for user with redis');
      client.delaySync(path);
      response = SyncMessage.error.diffs;
      response.content = {path: path};
      client.sendMessage(response);
      return;
    }

    if(locked) {
      response = SyncMessage.error.downstreamLocked;
      response.content = {path: path};
      client.delaySync(path);
      client.sendMessage(response);
      return;
    }

    checksums = message.content.checksums;

    rsync.diff(client.fs, path, checksums, rsyncOptions, function(err, diffs) {
      if(err) {
        log.error({err: err, client: client}, 'rsync.diff() error for ' + path);
        client.delaySync(path);
        response = SyncMessage.error.diffs;
        response.content = {path: path};
      } else {
        response = SyncMessage.response.diffs;
        response.content = {
          diffs: diffHelper.serialize(diffs),
          path: path
        };
      }

      client.sendMessage(response);
    });
  });
};

SyncProtocolHandler.prototype.handleDownstreamReset = function(message) {
  var client = ensureClient(this.client);
  var response;

  // We reject downstream sync SyncMessages unless the sync
  // is part of an initial downstream sync for a connection
  // or no upstream sync is in progress.
  SyncLock.isUserLocked(client.username, function(err, locked) {
    if(err) {
      log.error({err: err, client: client}, 'Error trying to look up lock for user with redis');
      response = SyncMessage.error.srclist;
      client.sendMessage(response);
      return;
    }

    if(locked && !client.is.initiating) {
      response = SyncMessage.error.downstreamLocked;
      client.downstreamInterrupted = true;
      client.sendMessage(response);
      return;
    }

    // Track the length of time this sync takes
    client._syncStarted = Date.now();

    rsync.sourceList(client.fs, '/', rsyncOptions, function(err, srcList) {
      if(err) {
        log.error({err: err, client: client}, 'rsync.sourceList() error');
        delete client._syncStarted;
        response = SyncMessage.error.srclist;
      } else {
        response = SyncMessage.request.chksum;
        response.content = {srcList: srcList, path: '/'};

        // `handleDownstreamReset` can be called for a client's initial downstream
        // filesystem update, or as a trigger for a new one. The state of the `sync`
        // object must be different in each case.
        client.state = message.is.authz ? States.INIT : States.OUT_OF_DATE;
      }

      client.sendMessage(response);
    });
  });
};

SyncProtocolHandler.prototype.handlePatchResponse = function(message) {
  var client = ensureClient(this.client);

  if(!client) {
    return;
  }

  if(message.invalidContent(['checksums'])) {
    log.warn({client: client, syncMessage: message}, 'Missing content.checksums in handlePatchResponse()');
    return client.sendMessage(SyncMessage.error.content);
  }

  var checksums = message.content.checksums;
  var path = message.content.path;

  rsync.utils.compareContents(client.fs, checksums, function(err, equal) {
    var response;

    // We need to check if equal is true because equal can have three possible
    // return value. 1. equal = true, 2. equal = false, 3. equal = undefined
    // we want to send error verification in case of err return or equal is false.
    if(equal) {
      response = SyncMessage.response.verification;
      // N/I
      client.endDownstream(path);
    } else {
      response = SyncMessage.error.verification;
    }

    response.content = {path: path};

    var info = client.info();
    if(info) {
      info.downstreamSyncs++;
    }

    client.sendMessage(response);
  });
};

SyncProtocolHandler.prototype.handleRootResponse = function(message) {
  var client = ensureClient(this.client);
  if(!client) {
    return;
  }

  if(!message.content || !message.content.path) {
    log.warn({client: client, syncMessage: message}, 'Missing content.path expected by handleRootResponse');
    return client.sendMessage(SyncMessage.error.content);
  }

  var path = message.content.path;
  var currentDownstreams = client.currentDownstream;
  var remainingDownstreams = client.outOfDate;
  var indexInCurrent = findPathIndexinArray(currentDownstreams, path);
  var indexInOutOfDate = findPathIndexinArray(remainingDownstreams, path);

  if(!indexInCurrent) {
    log.warn({client: client, syncMessage: message}, 'Client sent a path in handleRootResponse that is not currently downstreaming');
    return;
  }

  client.currentDownstream.splice(indexInCurrent, 1);
  client.outOfDate.splice(indexInOutOfDate, 1);
  log.info({client: client}, 'Ignored downstream sync due to ' + path + ' being out of client\'s root');
};
