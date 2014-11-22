var SyncMessage = require('../../lib/syncmessage');
var rsync = require('../../lib/rsync');
var rsyncUtils = rsync.utils;
var rsyncOptions = require('../../lib/constants').rsyncDefaults;
var serializeDiff = require('../../lib/diff').serialize;
var deserializeDiff = require('../../lib/diff').deserialize;
var states = require('./sync-states');
var steps = require('./sync-steps');
var dirname = require('../../lib/filer').Path.dirname;
var async = require('../../lib/async-lite');
var fsUtils = require('../../lib/fs-utils');
var log = require('./logger.js');

function onError(syncManager, err) {
  syncManager.session.step = steps.FAILED;
  syncManager.sync.onError(err);
}

// Checks if path is in masterPath
function hasCommonPath(masterPath, path) {
  if(masterPath === path) {
    return true;
  }

  if(path === '/') {
    return false;
  }

  return hasCommonPath(masterPath, dirname(path));
}

function handleRequest(syncManager, data) {
  var fs = syncManager.fs;
  var rawFs = syncManager.rawFs;
  var sync = syncManager.sync;

  function handleChecksumRequest() {
    var message;
    var path;
    var sourceList;

    if(data.invalidContent(['sourceList'])) {
      log.error('Path or source list not sent by server in handleChecksumRequest.', data);
      return onError(syncManager, new Error('Server sent insufficient content'));
    }

    path = data.content.path;
    sourceList = data.content.sourceList;

    // If the server requests to downstream a path that is not in the
    // root, ignore the downstream.
    if(path.indexOf(fs.root) !== 0) {
      message = SyncMessage.response.root;
      message.content = {path: path};
      log.info('Ignoring downstream sync for ' + path);
      return syncManager.send(message.stringify());
    }

    syncManager.downstreams.push(path);
    sync.onSyncing(path);

    rsync.checksums(rawFs, path, sourceList, rsyncOptions, function(err, checksums) {
      if(err) {
        log.error('Failed to generate checksums for ' + path + ' during downstream sync', err);
        return onError(syncManager, err);
      }

      fs.record(path);
      message = SyncMessage.request.diffs;
      message.content = {path: path, checksums: checksums};
      syncManager.send(message.stringify());
    });
  }

  function handleDiffRequest() {
    rsync.diff(fs, session.path, data.content.checksums, rsyncOptions, function(err, diffs) {
      if(err){
        return onError(syncManager, err);
      }

      session.step = steps.PATCH;

      var message = SyncMessage.response.diffs;
      message.content = {diffs: serializeDiff(diffs)};
      syncManager.send(message.stringify());
    });
  }


  if(data.is.checksums) {
    // DOWNSTREAM - CHKSUM
    handleChecksumRequest();
  } else if(data.is.diffs && session.is.syncing && session.is.diffs) {
    // UPSTREAM - DIFFS
    handleDiffRequest();
  } else {
    onError(syncManager, new Error('Failed to sync with the server. Current step is: ' +
                                    session.step + '. Current state is: ' + session.state));  }
}

function handleResponse(syncManager, data) {
  var fs = syncManager.fs;
  var rawFs = syncManager.rawFs;
  var sync = syncManager.sync;
  var session = syncManager.session;

  function resendChecksums() {
    if(!session.sourceList) {
      // Sourcelist was somehow reset, the entire downstream sync
      // needs to be restarted
      session.step = steps.FAILED;
      syncManager.send(SyncMessage.response.reset.stringify());
      return onError(syncManager, new Error('Fatal Error: Could not sync filesystem from server...trying again!'));
    }

    rsync.checksums(fs, session.path, session.sourceList, rsyncOptions, function(err, checksums) {
      if(err) {
        syncManager.send(SyncMessage.response.reset.stringify());
        return onError(syncManager, err);
      }

      var message = SyncMessage.request.diffs;
      message.content = {checksums: checksums};
      syncManager.send(message.stringify());
    });
  }

  function handleSourceListResponse() {
    session.state = states.SYNCING;
    session.step = steps.INIT;
    session.path = data.content.path;
    sync.onSyncing();

    rsync.sourceList(fs, session.path, rsyncOptions, function(err, sourceList) {
      if(err){
        syncManager.send(SyncMessage.request.reset.stringify());
        return onError(syncManager, err);
      }

      session.step = steps.DIFFS;

      var message = SyncMessage.request.chksum;
      message.content = {sourceList: sourceList};
      syncManager.send(message.stringify());
    });
  }

  function handlePatchAckResponse() {
    var syncedPaths = data.content.syncedPaths;
    session.state = states.READY;
    session.step = steps.SYNCED;

    function stampChecksum(path, callback) {
      fs.lstat(path, function(err, stats) {
        if(err) {
          if(err.code !== 'ENOENT') {
            return callback(err);
          }

          // Non-existent paths (usually due to renames or
          // deletes that are included in the syncedPaths)
          // cannot be stamped with a checksum
          return callback();
        }

        if(!stats.isFile()) {
          return callback();
        }

        rsyncUtils.getChecksum(fs, path, function(err, checksum) {
          if(err) {
            return callback(err);
          }

          fsUtils.setChecksum(fs, path, checksum, callback);
        });
      });
    }

    // As soon as an upstream sync happens, the files synced
    // become the last synced versions and must be stamped
    // with their checksums to version them
    async.eachSeries(syncedPaths, stampChecksum, function(err) {
      if(err) {
        return onError(syncManager, err);
      }

      sync.onCompleted(data.content.syncedPaths);
    });
  }

  function handlePatchResponse() {
    if(data.invalidContent(['diffs'])) {
      log.error('Path or diffs not sent by server in handlePatchResponse.', data);
      return onError(syncManager, new Error('Server sent insufficient content'));
    }

    var path = data.content.path;
    var diffs = deserializeDiff(data.content.diffs);
    var changedDuringDownstream = fs.changesDuringDownstream.indexOf(path);

    fs.stopRecording(path);

    if(changedDuringDownstream !== -1) {
      // TODO: Resend checksums
      return;
    }

    rsync.patch(rawFs, path, diffs, rsyncOptions, function(err, paths) {
      if(err) {
        log.error('Failed to patch ' + path + ' during downstream sync', err);
        return onError(syncManager, err);
      }

      syncManager.needsUpstream.push(paths.needsUpstream);

      rsyncUtils.generateChecksums(fs, paths.synced, true, function(err, checksums) {
        if(err) {
          log.error('Failed to generate checksums for ' + paths.synced + ' during downstream patch', err);
          return onError(syncManager, err);
        }

        var message = SyncMessage.response.patch;
        message.content = {path: path, checksums: checksums};
        syncManager.send(message.stringify());
      });
    });
  }

  function handleVerificationResponse() {
    var path = data.content.path;
    syncManager.downstreams.splice(syncManager.downstreams.indexOf(path));
    sync.onCompleted(path, syncManager.needsUpstream);
  }

  function handleUpstreamResetResponse() {
    var message = SyncMessage.request.sync;
    message.content = {path: session.path};
    syncManager.send(message.stringify());
  }

  if(data.is.sync) {
    // UPSTREAM - INIT
    handleSourceListResponse();
  } else if(data.is.patch && session.is.syncing && session.is.patch) {
    // UPSTREAM - PATCH
    handlePatchAckResponse();
  } else if(data.is.diffs) {
    // DOWNSTREAM - PATCH
    handlePatchResponse();
  } else if(data.is.verification && session.is.ready && session.is.patch) {
    // DOWNSTREAM - PATCH VERIFICATION
    handleVerificationResponse();
  }  else if (data.is.reset && session.is.failed) {
    handleUpstreamResetResponse();
  } else {
    onError(syncManager, new Error('Failed to sync with the server. Current step is: ' +
                                    session.step + '. Current state is: ' + session.state));  }
}

function handleError(syncManager, data) {
  var sync = syncManager.sync;
  var session = syncManager.session;
  var message = SyncMessage.response.reset;

  // DOWNSTREAM - ERROR
  if((((data.is.sourceList && session.is.synced)) ||
      (data.is.diffs && session.is.patch) && (session.is.ready || session.is.syncing))) {
    session.state = states.READY;
    session.step = steps.SYNCED;

    syncManager.send(message.stringify());
    onError(syncManager, new Error('Could not sync filesystem from server... trying again'));
  } else if(data.is.verification && session.is.patch && session.is.ready) {
    syncManager.send(message.stringify());
    onError(syncManager, new Error('Could not sync filesystem from server... trying again'));
  } else if(data.is.locked && session.is.ready && session.is.synced) {
    // UPSTREAM - LOCK
    onError(syncManager, new Error('Current sync in progress! Try again later!'));
  } else if(((data.is.chksum && session.is.diffs) ||
             (data.is.patch && session.is.patch)) &&
            session.is.syncing) {
    // UPSTREAM - ERROR
    var message = SyncMessage.request.reset;
    syncManager.send(message.stringify());
    onError(syncManager, new Error('Could not sync filesystem from server... trying again'));
  } else if(data.is.maxsizeExceeded) {
    // We are only emitting the error since this is can be sync again from the client
    syncManager.sync.emit('error', new Error('Maximum file size exceeded'));
  } else if(data.is.interrupted && session.is.syncing) {
    // SERVER INTERRUPTED SYNC (LOCK RELEASED EARLY)
    sync.onInterrupted();
  } else {
    onError(syncManager, new Error('Failed to sync with the server. Current step is: ' +
                                    session.step + '. Current state is: ' + session.state));
  }
}

function handleMessage(syncManager, data) {
  try {
    data = JSON.parse(data);
    data = SyncMessage.parse(data);
  } catch(e) {
    return onError(syncManager, e);
  }

  if (data.is.request) {
    handleRequest(syncManager, data);
  } else if(data.is.response){
    handleResponse(syncManager, data);
  } else if(data.is.error){
    handleError(syncManager, data);
  } else {
    onError(syncManager, new Error('Cannot handle message'));
  }
}

module.exports = handleMessage;
