// Minimal CSInterface shim: just the slice this panel uses. CEP
// injects window.__adobe_cep__; evalScript runs an ExtendScript string
// in the host (Premiere) and returns the result via callback. The full
// Adobe CSInterface.js can be dropped in to replace this if a broader
// API surface is ever needed.
function CSInterface() {}

CSInterface.prototype.evalScript = function (script, callback) {
  if (typeof callback !== "function") {
    callback = function () {};
  }
  if (window.__adobe_cep__ && window.__adobe_cep__.evalScript) {
    window.__adobe_cep__.evalScript(script, callback);
  } else {
    callback("EvalScript error: not running inside CEP");
  }
};

CSInterface.prototype.getSystemPath = function (pathType) {
  if (window.__adobe_cep__ && window.__adobe_cep__.getSystemPath) {
    return window.__adobe_cep__.getSystemPath(pathType);
  }
  return "";
};

var SystemPath = { EXTENSION: "extension" };
