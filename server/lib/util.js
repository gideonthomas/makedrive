// General utility methods

function findPathIndexinArray(array, path) {
  var index;

  for(var i = 0; i < array.length; i++) {
    if(array[i].path === path) {
      index = i;
      i = array.length + 1;
    }
  }

  return index;
}

module.exports = {
    findPathIndexinArray: findPathIndexinArray
};
