var expect = require('chai').expect;
var util = require('../lib/util.js');
var server = require('../lib/server-utils.js');
var MakeDrive = require('../../client/src');
var Filer = require('../../lib/filer.js');
var fsUtils = require('../../lib/fs-utils.js');

describe("Server bugs", function() {
  describe('[Issue 287]', function(){
    it('should fix timing issue with server holding onto active sync for user after completed', function(done) {
      var layout = {'/dir/file.txt': 'This is file 1'};

      server.setupSyncClient({manual: true, layout: layout}, function(err, client) {
        expect(err).not.to.exist;

        var fs = client.fs;
        var sync = client.sync;

        fs.unlink('/dir/file.txt', function(err) {
          expect(err).not.to.exist;

          sync.once('completed', function() {
            sync.once('disconnected', done);
            sync.disconnect();
          });

          sync.request();
        });
      });
    });
  });
});

describe('Client bugs', function() {
  var provider;

  beforeEach(function() {
    provider = new Filer.FileSystem.providers.Memory(util.username());
  });
  afterEach(function() {
    provider = null;
  });

  describe('[Issue 372]', function(){
    /**
     * This test creates a file and sync then disconenct
     * and change the file's content then try to connect and sync again.
     */
    it('should upstream newer changes made when disconnected and not create a conflicted copy', function(done) {
      var fs = MakeDrive.fs({provider: provider, manual: true, forceCreate: true});
      var sync = fs.sync;
      var jar;

      server.authenticatedConnection(function(err, result) {
        if(err) throw err;

        var layout = {'/hello': 'hello',
                      '/dir/world': 'world'
                     };
        jar = result.jar;

        sync.once('connected', function onConnected() {
          util.createFilesystemLayout(fs, layout, function(err) {
            if(err) throw err;

            sync.request();
          });
        });

        sync.once('synced', function onUpstreamCompleted() {
          sync.disconnect();
        });

        sync.once('disconnected', function onDisconnected() {
          // Re-sync with server and make sure we get our empty dir back
          sync.once('connected', function onSecondDownstreamSync() {
            layout['/hello'] = 'hello world';

            util.ensureFilesystem(fs, layout, function(err) {
              expect(err).not.to.exist;
            });
          });

          sync.once('synced', function reconnectedUpstream() {
            server.ensureRemoteFilesystem(layout, jar, function(err) {
              expect(err).not.to.exist;
              done();
            });
          });

          server.ensureRemoteFilesystem(layout, jar, function(err) {
            if(err) throw err;

            fs.writeFile('/hello', 'hello world', function (err) {
              if(err) throw err;

              fsUtils.isPathUnsynced(fs, '/hello', function(err, unsynced) {
                if(err) throw err;

                expect(unsynced).to.be.true;

                // Get a new token for this second connection
                server.getWebsocketToken(result, function(err, result) {
                  if(err) throw err;

                  jar = result.jar;
                  sync.connect(server.socketURL, result.token);
                });
              });
            });
          });
        });

        sync.connect(server.socketURL, result.token);
      });
    });
  });
});
