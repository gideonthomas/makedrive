var expect = require('chai').expect;
var util = require('../../lib/util.js');
var server = require('../../lib/server-utils.js');
var MakeDrive = require('../../../client/src');
var Filer = require('../../../lib/filer.js');

describe('Syncing dirs with entries of the same name', function(){
  var provider1;

  before(function(done) {
    server.start(done);
  });
  after(function(done) {
    server.shutdown(done);
  });

  beforeEach(function() {
    var username = util.username();
    provider1 = new Filer.FileSystem.providers.Memory(username);
  });
  afterEach(function() {
    provider1 = null;
  });

  it('should be able to sync a file contained within a directory of the same name', function(done) {
    server.authenticatedConnection(function(err, result1) {
      expect(err).not.to.exist;

      var fs1 = MakeDrive.fs({provider: provider1, manual: true, forceCreate: true});
      var sync1 = fs1.sync;
      var file1 = {'/path/path': 'This is file 1'};

      sync1.once('connected', function onClient1Connected() {
        expect(err).not.to.exist;

        util.createFilesystemLayout(fs1, file1, function(err) {
          expect(err).not.to.exist;

          util.ensureFilesystem(fs1, file1, function(err) {
            expect(err).not.to.exist;
            sync1.request();
          });
        });

        sync1.once('synced', function onClient1Upstream1() {
          server.ensureRemoteFilesystem(file1, result1.jar, function(err) {
            expect(err).not.to.exist;
            sync1.once('disconnected', done);
            sync1.disconnect();
          });
        });
      });

      sync1.connect(server.socketURL, result1.token);
    });
  });

  it('should be able to sync directories contained in a direcotry with the same name if it contains a file', function(done) {
    server.authenticatedConnection(function(err, result1) {
      expect(err).not.to.exist;

      var fs1 = MakeDrive.fs({provider: provider1, manual: true, forceCreate: true});
      var sync1 = fs1.sync;
      var file1 = {'/dir/dir/file1.txt': 'This is file 1'};

      sync1.once('connected', function onClient1Connected() {
        expect(err).not.to.exist;

        util.createFilesystemLayout(fs1, file1, function(err) {
          expect(err).not.to.exist;

          util.ensureFilesystem(fs1, file1, function(err) {
            expect(err).not.to.exist;
            sync1.request();
          });
        });

        sync1.once('synced', function onClient1Upstream1() {
          server.ensureRemoteFilesystem(file1, result1.jar, function(err) {
            expect(err).not.to.exist;
            sync1.once('disconnected', done);
            sync1.disconnect();
          });
        });
      });

      sync1.connect(server.socketURL, result1.token);
    });
  });
});
