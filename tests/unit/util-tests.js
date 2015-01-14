var expect = require('chai').expect;
var util = require('../lib/util.js');
var request = require('request');
var Filer = require('../../lib/filer.js');
var FileSystem = Filer.FileSystem;

describe('Test util.js', function(){
  describe('[Connection Helpers]', function() {
    it('util.authenticate should signin the given user and set session.user.username', function(done) {
      var username = util.username();
      util.authenticate({username: username}, function(err, result) {
        expect(err).not.to.exist;
        expect(result.username).to.equal(username);
        expect(result.jar).to.exist;

        // Trying to login a second time as this user will 401 if session info is set
        request.post({
          url: util.serverURL + '/mocklogin/' + username,
          jar: result.jar
        }, function(err, res) {
          expect(err).not.to.exist;
          expect(res.statusCode).to.equal(401);
          done();
        });
      });
    });

    it('util.authenticate should work with no options object passed', function(done) {
      util.authenticate(function(err, result) {
        expect(err).not.to.exist;
        expect(result.username).to.be.a.string;
        expect(result.jar).to.exist;
        done();
      });
    });

    it('util.getWebsocketToken should return a token on callback', function(done) {
      var username = util.username();
      util.authenticate({username: username}, function(err, authResult) {
        util.getWebsocketToken(authResult, function(err, tokenResult) {
          expect(tokenResult.token).to.be.a('string');
          done();
        });
      });
    });

    it('util.authenticatedConnection should signin and get a username, and ws token', function(done) {
      util.authenticatedConnection(function(err, result) {
        expect(err, "[err]").not.to.exist;
        expect(result, "[result]").to.exist;
        expect(result.jar, "[result.jar]").to.exist;
        expect(result.username, "[result.username]").to.be.a("string");
        expect(result.token, "[result.token]").to.be.a("string");
        expect(result.done, "[result.done]").to.be.a("function");

        request.get({
          url: util.serverURL + '/',
          jar: result.jar
        }, function(err, res) {
          expect(err).not.to.exist;
          expect(res.statusCode).to.equal(200);
          result.done();
          done();
        });
      });
    });

    it('util.authenticatedConnection should accept done function', function(done) {
      util.authenticatedConnection({done: done}, function(err, result) {
        expect(err).not.to.exist;
        expect(result).to.exist;
        expect(result.jar).to.exist;
        expect(result.syncId).to.be.a.string;
        expect(result.username).to.be.a.string;
        expect(result.done).to.be.a.function;

        result.done();
      });
    });
  });

  describe('[Misc Helpers]', function(){
    it('util.app should return the Express app instance', function () {
      expect(util.app).to.exist;
    });

    it('util.username should generate a unique username with each call', function() {
      var username1 = util.username();
      var username2 = util.username();
      expect(username1).to.be.a.string;
      expect(username2).to.be.a.string;
      expect(username1).not.to.equal(username2);
    });

    it('util.upload should allow a file to be uploaded and served', function(done) {
      var fs = require('fs');
      var Path = require('path');
      var content = fs.readFileSync(Path.resolve(__dirname, '../test-files/index.html'), {encoding: null});
      var username = util.username();

      util.upload(username, '/index.html', content, function(err) {
        expect(err).not.to.exist;

        util.authenticate({username: username}, function(err, result) {
          expect(err).not.to.exist;
          expect(result.jar).to.exist;

          // /p/index.html should come back as uploaded
          request.get({
            url: util.serverURL + '/p/index.html',
            jar: result.jar
          }, function(err, res, body) {
            expect(err).not.to.exist;
            expect(res.statusCode).to.equal(200);
            expect(body).to.equal(content.toString('utf8'));

            // /p/ should come back with dir listing
            request.get({
              url: util.serverURL + '/p/',
              jar: result.jar
            }, function(err, res, body) {
              expect(err).not.to.exist;
              expect(res.statusCode).to.equal(200);
              // Look for artifacts we'd expect in the directory listing
              expect(body).to.match(/<head><title>Index of \/<\/title>/);
              expect(body).to.match(/<a href="\/p\/index.html">index.html<\/a>/);
              done();
            });
          });
        });
      });
    });
  });

  describe('[Filesystem Helpers]', function() {
    var provider;

    beforeEach(function() {
      provider = new FileSystem.providers.Memory(util.username());
    });
    afterEach(function() {
      provider = null;
    });

    it('should createFilesystemLayout and ensureFilesystem afterward', function(done) {
      var fs = new FileSystem({provider: provider});
      var layout = {
        "/file1": "contents file1",
        "/dir1/file1": new Buffer([1,2,3]),
        "/dir1/file2": "contents file2",
        "/dir2": null
      };

      util.createFilesystemLayout(fs, layout, function(err) {
        expect(err).not.to.exist;

        util.ensureFilesystem(fs, layout, done);
      });
    });
  });

  describe('[Socket Helpers]', function(){
  });
});
