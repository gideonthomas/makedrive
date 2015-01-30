var expect = require('chai').expect;
var util = require('../../lib/util.js');
var server = require('../../lib/server-utils.js');
var MakeDrive = require('../../../client/src');
var Filer = require('../../../lib/filer.js');

describe('MakeDrive Client - sync symlink', function() {
  var provider;

  before(function(done) {
    server.start(done);
  });
  after(function(done) {
    server.shutdown(done);
  });

  beforeEach(function() {
    provider = new Filer.FileSystem.providers.Memory(util.username());
  });
  afterEach(function() {
    provider = null;
  });

  /**
   * This test creates a symlink from an existing file
   * and check that they both exists.
   */
  it('should sync symlink', function(done) {
    server.authenticatedConnection(function(err, result) {
      expect(err).not.to.exist;

      var fs = MakeDrive.fs({
        provider: provider,
        manual: true,
        forceCreate: true
      });
      var sync = fs.sync;

      var layout = {
        '/file1': 'contents of file1'
      };
      var finalLayout = {
        '/file1': 'contents of file1',
        '/file2': 'contents of file1'
      };

      sync.once('connected', function onConnected() {
        util.createFilesystemLayout(fs, layout, function(err) {
          expect(err).not.to.exist;

          sync.request();
        });
      });

      sync.once('synced', function onUpstreamCompleted() {
        server.ensureRemoteFilesystem(layout, result.jar, function() {
          fs.symlink('/file1', '/file2', function(err) {
            if (err) throw err;
            sync.once('completed', function onWriteSymlink() {
              server.ensureRemoteFilesystem(finalLayout, result.jar, function() {
                sync.once('disconnected', done);
                sync.disconnect();
              });
            });

            sync.request();
          });
        });
      });

      sync.connect(server.socketURL, result.token);
    });
  });

});
