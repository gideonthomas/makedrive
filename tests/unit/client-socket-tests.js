var expect = require('chai').expect;
var util = require('../lib/client-utils.js');
var SyncMessage = require('../../lib/syncmessage');
var MakeDrive = require('../../client/src');
var Filer = require('../../lib/filer.js');
var TOKEN = 'TOKEN';

function validateSocketMessage(message, expectedMessage, checkExists) {
  message = util.decodeSocketMessage(message);
  checkExists = checkExists || [];

  expect(message.type).to.equal(expectedMessage.type);
  expect(message.name).to.equal(expectedMessage.name);

  if(!expectedMessage.content) {
    expect(message.content).not.to.exist;
    return;
  }

  expect(message.content).to.exist;

  if(typeof message.content !== 'object') {
    expect(message.content).to.equal(expectedMessage.content);
    return;
  }

  Object.keys(expectedMessage.content).forEach(function(key) {
    if(checkExists.indexOf(key) !== -1) {
      expect(message.content[key]).to.exist;
    } else {
      expect(message.content[key]).to.equal(expectedMessage.content[key]);
    }
  });
}

describe('The Client', function() {
  var SocketServer;
  var provider;
  var MakeDriveOptions = {forceCreate: true, manual: true};

  describe('Socket protocol', function() {
    function incorrectEvent() {
      expect(true, '[Incorrect sync event emitted]').to.be.false;
    }

    beforeEach(function(done) {
      util.run(function(server) {
        SocketServer = server;
        provider = new Filer.FileSystem.providers.Memory(util.username());
        MakeDriveOptions.provider = provider;
        done();
      });
    });

    afterEach(function(){
      provider = null;
    });

    it('should emit a sync error if authentication fails', function(done) {
      var fs = MakeDrive.fs(MakeDriveOptions);
      var sync = fs.sync;

      SocketServer.once('connection', function(client) {
        client.once('message', function(message) {
          var message = SyncMessage.error.format;
          message.content = {error: 'Unable to parse/handle message, invalid message format.'};
          client.send(message.stringify());
        });
      });

      sync.once('connected', incorrectEvent);
      sync.once('error', function(err) {
        expect(err).to.exist;
        expect(err.message).to.equal('Cannot handle message');
        done();
      });

      sync.connect(util.socketURL, 'This is not a token');
    });

    it('should send emit a connected event on successfully authenticating with the server', function(done) {
      var fs = MakeDrive.fs(MakeDriveOptions);
      var sync = fs.sync;

      SocketServer.once('connection', function(client) {
        client.once('message', function() {
          client.send(SyncMessage.response.authz.stringify());
        });
      });

      sync.once('connected', done);
      sync.once('disconnected', incorrectEvent);
      sync.once('error', incorrectEvent);

      sync.connect(util.socketURL, 'This is a valid token');
    });
  });

  describe('Downstream syncs', function() {
    beforeEach(function(done) {
      util.run(function(server) {
        SocketServer = server;
        provider = new Filer.FileSystem.providers.Memory(util.username());
        MakeDriveOptions.provider = provider;
        done();
      });
    });

    afterEach(function(){
      provider = null;
    });

    it('should send a "RESPONSE" of "AUTHORIZED" to trigger an initial downstream sync', function(done) {
      var fs = MakeDrive.fs(MakeDriveOptions);
      var sync = fs.sync;

      SocketServer.once('connection', function(client) {
        client.once('message', function() {
          client.once('message', function(message) {
            validateSocketMessage(message, SyncMessage.response.authz);
            done();
          });

          client.send(SyncMessage.response.authz.stringify());
        });
      });

      sync.connect(util.socketURL, TOKEN);
    });
  });
});
