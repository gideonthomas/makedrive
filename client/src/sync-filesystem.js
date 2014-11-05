/**
 * An extended Filer FileSystem with wrapped methods
 * for writing that manage file metadata (xattribs)
 * reflecting sync state.
 */

var Filer = require('../../lib/filer.js');
var Shell = require('../../lib/filer-shell.js');
var Path = Filer.Path;
var fsUtils = require('../../lib/fs-utils.js');
var conflict = require('../../lib/conflict.js');
var resolvePath = require('../../lib/sync-path-resolver.js').resolve;

function SyncFileSystem(fs) {
  var self = this;
  var pathToSync;
  var modifiedPath;
  var root = '/';

  // Manage path resolution for sync path
  Object.defineProperty(self, 'pathToSync', {
    get: function() { return pathToSync; },
    set: function(path) {
      pathToSync = path ? resolvePath(pathToSync, path) : null;
    }
  });

  // Record modifications to the filesystem during a sync
  Object.defineProperty(fs, 'modifiedPath', {
    get: function() { return modifiedPath; },
    set: function(path) {
      modifiedPath = path ? resolvePath(modifiedPath, path) : null;
    }
  });

  // Expose the sync root for the filesystem but do not allow
  // direct modifications to it
  Object.defineProperty(self, 'root', {
    get: function() { return root; }
  });

  // The following non-modifying fs operations can be run as normal,
  // and are simply forwarded to the fs instance. NOTE: we have
  // included setting xattributes since we don't sync these to the server (yet).
  ['stat', 'fstat', 'lstat', 'exists', 'readlink', 'realpath',
   'readdir', 'open', 'close', 'fsync', 'read', 'readFile',
   'setxattr', 'fsetxattr', 'getxattr', 'fgetxattr', 'removexattr',
   'fremovexattr', 'watch'].forEach(function(method) {
     self[method] = function() {
       fs[method].apply(fs, arguments);
     };
  });

  function fsetUnsynced(fd, callback) {
    fsUtils.fsetUnsynced(fs, fd, callback);
  }

  function setUnsynced(path, callback) {
    fsUtils.setUnsynced(fs, path, callback);
  }

  // We wrap all fs methods that modify the filesystem in some way that matters
  // for syncing (i.e., changes we need to sync back to the server), such that we
  // can track things. Different fs methods need to do this in slighly different ways,
  // but the overall logic is the same.  The wrapMethod() fn defines this logic.
  function wrapMethod(method, pathArgPos, setUnsyncedFn, useParentPath) {
    return function() {
      var args = Array.prototype.slice.call(arguments, 0);
      var lastIdx = args.length - 1;
      var callback = args[lastIdx];

      // Grab the path or fd so we can use it to set the xattribute.
      // Most methods take `path` or `fd` as the first arg, but it's
      // second for some.
      var pathOrFD = args[pathArgPos];

      // Don't record extra sync-level details about modifications to an
      // existing conflicted copy, since we don't sync them.
      conflict.isConflictedCopy(fs, pathOrFD, function(err, conflicted) {
        // Deal with errors other than the path not existing (this fs
        // call might be creating it, in which case it's also not conflicted).
        if(err && err.code !== 'ENOENT') {
          return callback.apply(null, [err]);
        }

        // In most cases we want to use the path itself, but in the case
        // that a node is being removed, we want the parent dir.
        pathOrFD = useParentPath ? Path.dirname(pathOrFD) : pathOrFD;
        conflicted = !!conflicted;

        // If we try to remove or rename the sync root, change the root
        // to the parent of the current sync root.
        if(useParentPath && pathOrFD === root) {
          root = Path.dirname(pathOrFD);
        }

        // Check to see if it is a non-conflicted path or an open file descriptor
        // and only record the path if it is contained in the specified
        // syncing root of the filesystem.
        // TODO: Deal with a case of fs.open for a path with a write flag
        // https://github.com/mozilla/makedrive/issues/210.
        if(!conflicted && !fs.openFiles[pathOrFD] && pathOrFD.indexOf(root) === 0) {
          self.pathToSync = pathOrFD;
          // Record the path that was modified on the fs
          fs.modifiedPath = pathOrFD;
        }

        args[lastIdx] = function wrappedCallback() {
          var args = Array.prototype.slice.call(arguments, 0);
          // Error object on callback, bail now
          if(args[0]) {
            return callback.apply(null, args);
          }

          setUnsyncedFn(pathOrFD, function(err) {
            if(err) {
              return callback(err);
            }
            callback.apply(null, args);
          });
        };

        fs[method].apply(fs, args);
      });
    };
  }

  // Wrapped fs methods that have path at first arg position and use paths
  ['truncate', 'mknod', 'mkdir', 'utimes', 'writeFile',
   'appendFile'].forEach(function(method) {
     self[method] = wrapMethod(method, 0, setUnsynced);
  });

  // Wrapped fs methods that have path at second arg position
  ['link', 'symlink'].forEach(function(method) {
    self[method] = wrapMethod(method, 1, setUnsynced);
  });

  // Wrapped fs methods that have path at second arg position, and need to use the parent path.
  ['rename'].forEach(function(method) {
    self[method] = wrapMethod(method, 1, setUnsynced, true);
  });

  // Wrapped fs methods that use file descriptors
  ['ftruncate', 'futimes', 'write'].forEach(function(method) {
    self[method] = wrapMethod(method, 0, fsetUnsynced);
  });

  // Wrapped fs methods that have path at first arg position and use parent
  // path for writing unsynced metadata (i.e., removes node)
  ['rmdir', 'unlink'].forEach(function(method) {
    self[method] = wrapMethod(method, 0, setUnsynced, true);
  });

  // We also want to do extra work in the case of a rename.
  // If a file is a conflicted copy, and a rename is done,
  // remove the conflict.
  var rename = self.rename;
  self.rename = function(oldPath, newPath, callback) {
    rename(oldPath, newPath, function(err) {
      if(err) {
        return callback(err);
      }

      conflict.isConflictedCopy(fs, newPath, function(err, conflicted) {
        if(err) {
          return callback(err);
        }

        if(conflicted) {
          conflict.removeFileConflict(fs, newPath, callback);
        } else {
          callback();
        }
      });
    });
  };

  // Expose fs.Shell() but use wrapped sync filesystem instance vs fs.
  // This is a bit brittle, but since Filer doesn't expose the Shell()
  // directly, we deal with it by doing a deep require into Filer's code
  // ourselves. The other down side of this is that we're now including
  // the Shell code twice (once in filer.js, once here). We need to
  // optimize this when we look at making MakeDrive smaller.
  self.Shell = function(options) {
    return new Shell(self, options);
  };

  // Expose extra operations for checking whether path/fd is unsynced
  self.getUnsynced = function(path, callback) {
    fsUtils.getUnsynced(fs, path, callback);
  };
  self.fgetUnsynced = function(fd, callback) {
    fsUtils.fgetUnsynced(fs, fd, callback);
  };

  // Expose a setter for the sync root
  self.setRoot = function(path, callback) {
    if(!path) {
      root = '/';
      self.pathToSync = root;
      fs.modifiedPath = null;

      return callback();
    }

    fs.lstat(path, function(err, stats) {
      if(!err) {
        if(!stats.isDirectory()) {
          return callback(new Filer.Errors.ENOTDIR(path + ' is not a directory'));
        }

        root = path;
        self.pathToSync = root;
        fs.modifiedPath = null;

        return;
      }

      // Fatal error
      if(err.code !== 'ENOENT') {
        return callback(err);
      }

      fs.mkdir(path, function(err) {
        if(err) {
          return callback(err);
        }

        root = path;
        self.pathToSync = root;
        fs.modifiedPath = null;

        callback();
      });
    });
  };
}

module.exports = SyncFileSystem;
