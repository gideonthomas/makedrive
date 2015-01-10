var expect = require('chai').expect;
var util = require('../lib/util.js');
var SyncMessage = require('../../lib/syncmessage');
var WS = require('ws');
var syncModes = require('../../lib/constants').syncModes;

describe('The Server', function(){
  describe('Socket protocol', function() {
    var socket, socket2;

    afterEach(function() {
      if(socket) {
        socket.close();
      }
      if(socket2) {
        socket2.close();
      }
    });

    it('should close a socket if bad data is sent in place of websocket-auth token', function(done) {
      util.run(function() {
        socket = new WS(util.socketURL);

        socket.onmessage = function() {
          expect(true).to.be.false;
        };
        socket.onopen = function() {
          socket.send('This is not a token');
        };
        socket.onclose = function(closeMessage) {
          expect(closeMessage).to.exist;
          expect(closeMessage.code).to.equal(1011);
          done();
        };
      });
    });

    it('shouldn\'t allow the same token to be used twice', function(done) {
      util.authenticatedConnection({done: done}, function(err, result) {
        expect(err).not.to.exist;

        socket = new WS(util.socketURL);
        var authMsg = {token: result.token};

        socket.onmessage = function() {
          socket2 = new WS(util.socketURL);

          socket2.onmessage = function() {
            expect(true).to.be.false;
          };
          socket2.onopen = function() {
            socket2.send(JSON.stringify(authMsg));
          };
          socket2.onclose = function(closeMessage) {
            expect(closeMessage).to.exist;
            expect(closeMessage.code).to.equal(1008);
            done();
          };
        };
        socket.onopen = function() {
          socket.send(JSON.stringify(authMsg));
        };
      });
    });

    it('should send a RESPONSE named "AUTHZ" after receiving a valid token and syncId', function(done) {
      util.authenticatedConnection({done: done}, function(err, result) {
        expect(err).not.to.exist;

        socket = new WS(util.socketURL);
        socket.onmessage = function(message) {
          expect(message).to.exist;
          expect(message.data).to.exist;

          var data = JSON.parse(message.data);

          expect(data.type).to.equal(SyncMessage.RESPONSE);
          expect(data.name).to.equal(SyncMessage.AUTHZ);
          done();
        };
        socket.onopen = function() {
          socket.send(JSON.stringify({token: result.token}));
        };
      });
    });

    it('should allow two socket connections for the same username from different clients', function(done) {
      util.authenticatedConnection(function(err, result) {
        expect(err).not.to.exist;

        socket = new WS(util.socketURL);
        socket.onmessage = function() {
          util.authenticatedConnection({username: result.username}, function(err, result2) {
            expect(err).not.to.exist;
            expect(result2).to.exist;
            expect(result2.username).to.equal(result.username);
            expect(result2.token).not.to.equal(result.token);

            socket2 = new WS(util.socketURL);
            socket2.onmessage = function(message) {
              expect(message).to.exist;
              expect(message.data).to.exist;

              var data = JSON.parse(message.data);

              expect(data.type).to.equal(SyncMessage.RESPONSE);
              expect(data.name).to.equal(SyncMessage.AUTHZ);
              done();
            };
            socket2.onopen = function() {
              socket2.send(JSON.stringify({token: result2.token}));
            };
          });
        };
        socket.onopen = function() {
          socket.send(JSON.stringify({token: result.token}));
        };
      });
    });

    it('should send a format SyncMessage error if a non-SyncMessage is sent', function(done) {
      util.authenticatedSocket(function(err, result, socket) {
        if(err) throw err;

        socket.onmessage = function(message) {
          message = util.decodeSocketMessage(message);
          expect(message.type).to.equal(SyncMessage.ERROR);
          expect(message.name).to.equal(SyncMessage.INFRMT);
          socket.close();
          done();
        };

        socket.send(JSON.stringify({message: 'This is not a sync message'}));
      });
    });
  });

  describe('Downstream syncs', function(){
    var authResponse = SyncMessage.response.authz.stringify();

    it('should send a "REQUEST" for "CHECKSUMS" SyncMessage to trigger a downstream when a client connects and the server has a non-empty filesystem', function(done) {
      var username = util.username();
      var file = {path: '/file', content: 'This is a file'};

      util.upload(username, file.path, file.content, function(err) {
        if(err) throw err;

        util.authenticatedSocket({username: username}, function(err, result, socket) {
          if(err) throw err;

          socket.onmessage = function(message) {
            message = util.decodeSocketMessage(message);
            expect(message.type).to.equal(SyncMessage.REQUEST);
            expect(message.name).to.equal(SyncMessage.CHECKSUMS);
            expect(message.content).to.exist;
            expect(message.content.path).to.equal(file.path);
            expect(message.content.type).to.equal(syncModes.CREATE);
            expect(message.content.sourceList).to.exist;
            done();
          };

          socket.send(authResponse);
        });
      });
    });

    it('should send a "RESPONSE" of "DIFFS" SyncMessage when requested for diffs', function(done) {
      var username = util.username();
      var file = {path: '/file', content: 'This is a file'};
      var checksums = util.generateChecksums([file]);
      var diffRequest = SyncMessage.request.diffs;
      diffRequest.content = {path: file.path, type: syncModes.CREATE, checksums: checksums[0]};

      util.upload(username, file.path, file.content, function(err) {
        if(err) throw err;

        util.authenticatedSocket({username: username}, function(err, result, socket) {
          if(err) throw err;

          socket.onmessage = function(message) {
            message = util.decodeSocketMessage(message);
            expect(message.type).to.equal(SyncMessage.RESPONSE);
            expect(message.name).to.equal(SyncMessage.DIFFS);
            expect(message.content).to.exist;
            expect(message.content.path).to.equal(file.path);
            expect(message.content.type).to.equal(syncModes.CREATE);
            expect(message.content.diffs).to.exist;
            done();
          };

          socket.send(diffRequest.stringify());
        });
      });
    });

    it('should send a "RESPONSE" of "VERIFICATION" SyncMessage on receiving a patch response', function(done) {
      var username = util.username();
      var initializedDownstream = false;
      var file = {path: '/file', content: 'This is a file'};
      var checksums = util.generateValidationChecksums([file]);
      var patchResponse = SyncMessage.response.patch;
      patchResponse.content = {path: file.path, type: syncModes.CREATE, checksums: checksums[0]};

      util.upload(username, file.path, file.content, function(err) {
        if(err) throw err;

        util.authenticatedSocket({username: username}, function(err, result, socket) {
          if(err) throw err;

          socket.onmessage = function(message) {
            if(!initializedDownstream) {
              initializedDownstream = true;
              return socket.send(patchResponse.stringify());
            }

            message = util.decodeSocketMessage(message);
            expect(message.type).to.equal(SyncMessage.RESPONSE);
            expect(message.name).to.equal(SyncMessage.VERIFICATION);
            expect(message.content).to.exist;
            expect(message.content.path).to.equal(file.path);
            expect(message.content.type).to.equal(syncModes.CREATE);
            done();
          };

          socket.send(authResponse);
        });
      });
    });

  //   it('should block a downstream sync diffs request from the client after an upstream sync has been started', function(done) {
  //     // First client connects
  //     util.authenticatedConnection({done: done}, function(err, result1) {
  //       expect(err).not.to.exist;

  //       // Second client connects
  //       util.authenticatedConnection({username: result1.username}, function(err, result2) {
  //         expect(err).not.to.exist;

  //         // First client completes the initial downstream sync
  //         util.prepareUpstreamSync(result1.username, result1.token, function(err, data1, fs1, socketPackage1){
  //           expect(err).not.to.exist;

  //           // First client completes the first step of a downstream sync
  //           util.downstreamSyncSteps.requestSync(socketPackage1, data1, fs1, function(err, downstreamData) {
  //             expect(err).to.not.exist;

  //             // Second client begins an upstream sync
  //             util.prepareUpstreamSync('requestSync', result1.username, result2.token, function(data2, fs2, socketPackage2) {
  //               // First client attempts the second step of an downstream sync, expecting an error
  //               util.downstreamSyncSteps.generateDiffs(socketPackage1, downstreamData, fs1, function(msg, cb) {
  //                 msg = util.toSyncMessage(msg);

  //                 expect(msg).to.exist;
  //                 expect(msg.type).to.equal(SyncMessage.ERROR);
  //                 expect(msg.name).to.equal(SyncMessage.DOWNSTREAM_LOCKED);

  //                 cb();
  //               }, function() {
  //                 util.cleanupSockets(function(){
  //                   result1.done();
  //                   result2.done();
  //                 }, socketPackage1, socketPackage2);
  //               });
  //             });
  //           });
  //         });
  //       });
  //     });
  //   });

  //   it('should allow the patch verification from the client after an upstream sync has been started', function(done) {
  //     // First client connects
  //     util.authenticatedConnection({done: done}, function(err, result1) {
  //       expect(err).not.to.exist;

  //       // Second client connects
  //       util.authenticatedConnection({username: result1.username}, function(err, result2) {
  //         expect(err).not.to.exist;

  //         // First client completes the initial downstream sync
  //         util.prepareUpstreamSync(result1.username, result1.token, function(err, data1, fs1, socketPackage1){
  //           expect(err).not.to.exist;

  //           // First client completes the first step of a downstream sync
  //           util.downstreamSyncSteps.requestSync(socketPackage1, data1, fs1, function(err, downstreamData) {
  //             expect(err).to.not.exist;

  //             // First client completes the second step of a downstream sync
  //             util.downstreamSyncSteps.generateDiffs(socketPackage1, downstreamData, fs1, function(err, downstreamData2) {
  //               expect(err).to.not.exist;

  //               // Second client begins an upstream sync
  //               util.prepareUpstreamSync('requestSync', result1.username, result2.token, function(data2, fs2, socketPackage2) {

  //                 // First client attempts the final step of an downstream sync, expect all to be well.
  //                 util.downstreamSyncSteps.patchClientFilesystem(socketPackage1, downstreamData2, fs1, function(err) {
  //                   expect(err).to.not.exist;

  //                   util.cleanupSockets(function(){
  //                     result1.done();
  //                     result2.done();
  //                   }, socketPackage1, socketPackage2);
  //                 });
  //               });
  //             });
  //           });
  //         });
  //       });
  //     });
  //   });
  });

  // describe('Generate Diffs', function() {
  //   it('should return an RESPONSE message with the diffs', function(done) {
  //     util.authenticatedConnection({ done: done }, function( err, result ) {
  //       expect(err).not.to.exist;

  //       util.prepareDownstreamSync(result.username, result.token, function(err, syncData, fs, socketPackage) {
  //         util.downstreamSyncSteps.generateDiffs(socketPackage, syncData, fs, function(msg, cb) {
  //           msg = util.toSyncMessage(msg);

  //           expect(msg.type, "[Message type error: \"" + (msg.content && msg.content.error) +"\"]" ).to.equal(SyncMessage.RESPONSE);
  //           expect(msg.name).to.equal(SyncMessage.DIFFS);
  //           expect(msg.content).to.exist;
  //           expect(msg.content.diffs).to.exist;
  //           cb();
  //         }, function() {
  //           util.cleanupSockets(result.done, socketPackage);
  //         });
  //       });
  //     });
  //   });

  //   it('should return an ERROR type message named DIFFS when faulty checksums are sent', function(done) {
  //     util.authenticatedConnection({ done: done }, function( err, result ) {
  //       expect(err).not.to.exist;

  //       util.prepareDownstreamSync(result.username, result.token, function(err, syncData, fs, socketPackage) {
  //         var diffRequest = SyncMessage.request.diffs;
  //         diffRequest.content = {
  //           checksums: "jargon"
  //         };
  //         util.sendSyncMessage(socketPackage, diffRequest, function(msg) {
  //           msg = util.toSyncMessage(msg);

  //           expect(msg.type, "[Message type error: \"" + (msg.content && msg.content.error) +"\"]" ).to.equal(SyncMessage.ERROR);
  //           expect(msg.name).to.equal(SyncMessage.DIFFS);
  //           util.cleanupSockets(result.done, socketPackage);
  //         });
  //       });
  //     });
  //   });

  //   it('should return an SyncMessage with error content when no checksums are sent', function(done) {
  //     util.authenticatedConnection({ done: done }, function( err, result ) {
  //       expect(err).not.to.exist;

  //       util.prepareDownstreamSync(result.username, result.token, function(err, syncData, fs, socketPackage) {
  //         var diffRequest = SyncMessage.request.diffs;
  //         util.sendSyncMessage(socketPackage, diffRequest, function(msg) {
  //           msg = util.toSyncMessage(msg);

  //           expect(msg).to.eql(SyncMessage.error.content);
  //           util.cleanupSockets(result.done, socketPackage);
  //         });
  //       });
  //     });
  //   });
  // });

  // describe('Patch the client filesystem', function() {
  //   it('should make the server respond with a RESPONSE SYNC SyncMessage after ending a downstream sync, and initiating an upstream sync', function(done) {
  //     util.authenticatedConnection({ done: done }, function( err, result ) {
  //       expect(err).not.to.exist;

  //       util.prepareDownstreamSync('generateDiffs', result.username, result.token, function(err, syncData, fs, socketPackage) {
  //         util.downstreamSyncSteps.patchClientFilesystem(socketPackage, syncData, fs, function(msg, cb) {
  //           msg = util.toSyncMessage(msg);
  //           var startSyncMsg = SyncMessage.request.sync;
  //           startSyncMsg.content = {path: '/'};
  //           util.sendSyncMessage(socketPackage, startSyncMsg, function(message){
  //             message = util.toSyncMessage(message);

  //             expect(message).to.exist;
  //             expect(message.type).to.equal(SyncMessage.RESPONSE);
  //             expect(message.name).to.equal(SyncMessage.SYNC);

  //             cb();
  //           });
  //         }, function() {
  //           util.cleanupSockets(result.done, socketPackage);
  //         });
  //       });
  //     });
  //   });

  //   it('should return an IMPLEMENTATION ERROR SyncMessage when sent out of turn', function(done) {
  //     util.authenticatedConnection({ done: done }, function( err, result ) {
  //       expect(err).not.to.exist;

  //       util.prepareDownstreamSync(result.username, result.token, function(err, data, fs, socketPackage) {
  //         var startSyncMsg = SyncMessage.request.sync;
  //         startSyncMsg.content = {path: '/'};
  //         util.sendSyncMessage(socketPackage, startSyncMsg, function(msg){
  //           msg = util.toSyncMessage(msg);

  //           expect(msg).to.exist;
  //           expect(msg.type).to.equal(SyncMessage.ERROR);
  //           expect(msg.name).to.equal(SyncMessage.IMPL);
  //           expect(msg.content).to.exist;
  //           expect(msg.content.error).to.exist;

  //           util.cleanupSockets(result.done, socketPackage);
  //         });
  //       });
  //     });
  //   });
  // });

  // describe('Request checksums', function() {
  //   it('should return a CONTENT error SyncMessage if srcList isn\'t passed', function(done) {
  //     // Authorize a user, open a socket, authorize and complete a downstream sync
  //     util.authenticatedConnection({ done: done }, function( err, result ) {
  //       expect(err).not.to.exist;

  //       util.prepareUpstreamSync('requestSync', result.username, result.token, function(syncData, fs, socketPackage) {
  //         var requestChksumMsg = SyncMessage.request.chksum;
  //         requestChksumMsg.content = {
  //           path: syncData.path
  //         };
  //         socketPackage.socket.send(requestChksumMsg.stringify());

  //         util.sendSyncMessage(socketPackage, requestChksumMsg, function(msg) {
  //           msg = util.toSyncMessage(msg);

  //           expect(msg).to.deep.equal(SyncMessage.error.content);

  //           util.cleanupSockets(result.done, socketPackage);
  //         });
  //       });
  //     });
  //   });
  //   it('should return a CONTENT error SyncMessage if no data is passed', function(done) {
  //     // Authorize a user, open a socket, authorize and complete a downstream sync
  //     util.authenticatedConnection({ done: done }, function( err, result ) {
  //       expect(err).not.to.exist;

  //       util.prepareUpstreamSync('requestSync', result.username, result.token, function(syncData, fs, socketPackage) {
  //         var requestChksumMsg = SyncMessage.request.chksum;
  //         requestChksumMsg.content = {};
  //         socketPackage.socket.send(requestChksumMsg.stringify());

  //         util.sendSyncMessage(socketPackage, requestChksumMsg, function(msg) {
  //           msg = util.toSyncMessage(msg);

  //           expect(msg).to.deep.equal(SyncMessage.error.content);

  //           util.cleanupSockets(result.done, socketPackage);
  //         });
  //       });
  //     });
  //   });
  // });
});
