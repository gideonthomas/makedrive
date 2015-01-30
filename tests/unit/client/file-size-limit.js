var expect = require('chai').expect;
var util = require('../../lib/util.js');
var server = require('../../lib/server-utils.js');
var MakeDrive = require('../../../client/src');
var Filer = require('../../../lib/filer.js');
var MAX_SIZE_BYTES = 2000000;

describe('Syncing file larger than size limit', function(){
  var provider;

  before(function(done) {
    server.start(done);
  });
  after(function(done) {
    server.shutdown(done);
  });

  beforeEach(function() {
    var username = util.username();
    provider = new Filer.FileSystem.providers.Memory(username);
  });
  afterEach(function() {
    provider = null;
  });

  it('should return an error if file exceeded the size limit', function(done) {
    server.authenticatedConnection(function(err, result) {
      expect(err).not.to.exist;

      var fs = MakeDrive.fs({provider: provider, manual: true, forceCreate: true});
      var sync = fs.sync;
      var layout = {'/hello.txt': new Filer.Buffer(MAX_SIZE_BYTES+1) };

      sync.once('connected', function onClientConnected() {
        util.createFilesystemLayout(fs, layout, function(err) {
          expect(err).not.to.exist;

          sync.request();
        });
      });

      sync.once('error', function onClientError(error) {
        expect(error).to.eql(new Error('Sync interrupted for path /hello.txt'));
        sync.once('disconnected', done);
        sync.disconnect();
      });

      sync.connect(server.socketURL, result.token);
    });
  });

  it('should not return an error if file did not exceed the size limit', function(done) {
    var everError = false;

    server.authenticatedConnection(function(err, result) {
      expect(err).not.to.exist;

      var fs = MakeDrive.fs({provider: provider, manual: true, forceCreate: true});
      var sync = fs.sync;
      var layout = {'/hello.txt': new Filer.Buffer(MAX_SIZE_BYTES) };

      sync.once('connected', function onClientConnected() {
        util.createFilesystemLayout(fs, layout, function(err) {
          expect(err).not.to.exist;

          sync.request();
        });
      });

      sync.once('completed', function() {
        expect(everError).to.be.false;
        sync.once('disconnected', done);
        sync.disconnect();
      });

      sync.once('error', function onClientError() {
        everError = true;
      });

      sync.connect(server.socketURL, result.token);
    });
  });
});
