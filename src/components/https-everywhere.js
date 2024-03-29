// LOG LEVELS ---

VERB=1;
DBUG=2;
INFO=3;
NOTE=4;
WARN=5;

//---------------

https_domains = {};              // maps domain patterns (with at most one
                                 // wildcard) to RuleSets

https_everywhere_blacklist = {}; // URLs we've given up on rewriting because
                                 // of redirection loops

//
const CI = Components.interfaces;
const CC = Components.classes;
const CU = Components.utils;
const CR = Components.results;

const CP_SHOULDPROCESS = 4;

const SERVICE_CTRID = "@eff.org/https-everywhere;1";
const SERVICE_ID=Components.ID("{32c165b4-fe5e-4964-9250-603c410631b4}");
const SERVICE_NAME = "Encrypts your communications with a number of major websites";

const LLVAR = "LogLevel";

const IOS = CC["@mozilla.org/network/io-service;1"].getService(CI.nsIIOService);
const OS = CC['@mozilla.org/observer-service;1'].getService(CI.nsIObserverService);
const LOADER = CC["@mozilla.org/moz/jssubscript-loader;1"].getService(CI.mozIJSSubScriptLoader);
const _INCLUDED = {};

// NoScript uses this blob to include js constructs that stored in the chrome/
// directory, but are not attached to the Firefox UI (normally, js located
// there is attached to an Overlay and therefore is part of the UI).

// Reasons for this: things in components/ directory cannot be split into
// separate files; things in chrome/ can be

const INCLUDE = function(name) {
  if (arguments.length > 1)
    for (var j = 0, len = arguments.length; j < len; j++)
      INCLUDE(arguments[j]);
  else if (!_INCLUDED[name]) {
    try {
      LOADER.loadSubScript("chrome://https-everywhere/content/code/"
              + name + ".js");
      _INCLUDED[name] = true;
    } catch(e) {
      dump("INCLUDE " + name + ": " + e + "\n");
    }
  }
}

const WP_STATE_START = CI.nsIWebProgressListener.STATE_START;
const WP_STATE_STOP = CI.nsIWebProgressListener.STATE_STOP;
const WP_STATE_DOC = CI.nsIWebProgressListener.STATE_IS_DOCUMENT;
const WP_STATE_START_DOC = WP_STATE_START | WP_STATE_DOC;
const WP_STATE_RESTORING = CI.nsIWebProgressListener.STATE_RESTORING;

const LF_VALIDATE_ALWAYS = CI.nsIRequest.VALIDATE_ALWAYS;
const LF_LOAD_BYPASS_ALL_CACHES = CI.nsIRequest.LOAD_BYPASS_CACHE | CI.nsICachingChannel.LOAD_BYPASS_LOCAL_CACHE;

const NS_OK = 0;
const NS_BINDING_ABORTED = 0x804b0002;
const NS_BINDING_REDIRECTED = 0x804b0003;
const NS_ERROR_UNKNOWN_HOST = 0x804b001e;
const NS_ERROR_REDIRECT_LOOP = 0x804b001f;
const NS_ERROR_CONNECTION_REFUSED = 0x804b000e;
const NS_ERROR_NOT_AVAILABLE = 0x804b0111;

const LOG_CONTENT_BLOCK = 1;
const LOG_CONTENT_CALL = 2;
const LOG_CONTENT_INTERCEPT = 4;
const LOG_CHROME_WIN = 8;
const LOG_XSS_FILTER = 16;
const LOG_INJECTION_CHECK = 32;
const LOG_DOM = 64;
const LOG_JS = 128;
const LOG_LEAKS = 1024;
const LOG_SNIFF = 2048;
const LOG_CLEARCLICK = 4096;
const LOG_ABE = 8192;

const HTML_NS = "http://www.w3.org/1999/xhtml";

const WHERE_UNTRUSTED = 1;
const WHERE_TRUSTED = 2;
const ANYWHERE = 3;

const DUMMYOBJ = {};

const EARLY_VERSION_CHECK = !("nsISessionStore" in CI && typeof(/ /) === "object");

const OBSERVER_TOPIC_URI_REWRITE = "https-everywhere-uri-rewrite";

function xpcom_generateQI(iids) {
  var checks = [];
  for each (var iid in iids) {
    checks.push("CI." + iid.name + ".equals(iid)");
  }
  var src = checks.length
    ? "if (" + checks.join(" || ") + ") return this;\n"
    : "";
  return new Function("iid", src + "throw Components.results.NS_ERROR_NO_INTERFACE;");
}

function xpcom_checkInterfaces(iid,iids,ex) {
  for (var j = iids.length; j-- >0;) {
    if (iid.equals(iids[j])) return true;
  }
  throw ex;
}

INCLUDE('IOUtil', 'HTTPSRules', 'HTTPS', 'Thread', 'ApplicableList');

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

// This is black magic for storing Expando data w/ an nsIDOMWindow 
// See http://pastebin.com/qY28Jwbv , 
// https://developer.mozilla.org/en/XPCOM_Interface_Reference/nsIControllers

StorageController.prototype = {
  QueryInterface: XPCOMUtils.generateQI(
    [ Components.interfaces.nsISupports,
      Components.interfaces.nsIController ]),
  wrappedJSObject: null,  // Initialized by constructor
  supportsCommand: function (cmd) {return (cmd == this.command)},
  isCommandEnabled: function (cmd) {return (cmd == this.command)},
  onEvent: function(eventName) {return true},
  doCommand: function() {return true}
};

function StorageController(command) {
  this.command = command;
  this.data = {};
  this.wrappedJSObject = this;
};

/*var Controller = Class("Controller", XPCOM(CI.nsIController), {
  init: function (command, data) {
      this.command = command;
      this.data = data;
  },
  supportsCommand: function (cmd) cmd === this.command
});*/

function HTTPSEverywhere() {

  // Set up logging in each component:
  HTTPS.log = HTTPSRules.log = RuleWriter.log = this.log = https_everywhereLog;

  this.log = https_everywhereLog;
  this.wrappedJSObject = this;
  this.https_rules = HTTPSRules;
  this.INCLUDE=INCLUDE;
  this.ApplicableList = ApplicableList;

  // We need to use observers instead of categories for FF3.0 for these:
  // https://developer.mozilla.org/en/Observer_Notifications
  // https://developer.mozilla.org/en/nsIObserverService.
  // https://developer.mozilla.org/en/nsIObserver
  // We also use the observer service to let other extensions know about URIs
  // we rewrite.
  this.obsService = CC["@mozilla.org/observer-service;1"]
                    .getService(Components.interfaces.nsIObserverService);
  this.obsService.addObserver(this, "profile-before-change", false);
  this.obsService.addObserver(this, "profile-after-change", false);
  this.obsService.addObserver(this, "sessionstore-windows-restored", false);
  return;
}




// This defines for Mozilla what stuff HTTPSEverywhere will implement.

// We need to use both ContentPolicy and Observer, because there are some
// things, such as Favicons, who don't get caught by ContentPolicy; we don't
// yet know why we don't just use the observer :/

// ChannelEventSink seems to be necessary in order to handle redirects (eg
// HTTP redirects) correctly.

HTTPSEverywhere.prototype = {
  // properties required for XPCOM registration:
  classDescription: SERVICE_NAME,
  classID:          SERVICE_ID,
  contractID:       SERVICE_CTRID,

  _xpcom_factory: {
    createInstance: function (outer, iid) {
      if (outer != null)
        throw Components.results.NS_ERROR_NO_AGGREGATION;
      if (!HTTPSEverywhere.instance)
        HTTPSEverywhere.instance = new HTTPSEverywhere();
      return HTTPSEverywhere.instance.QueryInterface(iid);
    },

    QueryInterface: XPCOMUtils.generateQI(
      [ Components.interfaces.nsISupports,
        Components.interfaces.nsIModule,
        Components.interfaces.nsIFactory ])
  },

  // [optional] an array of categories to register this component in.
  _xpcom_categories: [
    {
      category: "app-startup",
    },
    {
      category: "content-policy",
    },
  ],

  // QueryInterface implementation, e.g. using the generateQI helper
  QueryInterface: XPCOMUtils.generateQI(
    [ Components.interfaces.nsIObserver,
      Components.interfaces.nsIMyInterface,
      Components.interfaces.nsISupports,
      Components.interfaces.nsIContentPolicy,
      Components.interfaces.nsISupportsWeakReference,
      Components.interfaces.nsIWebProgressListener,
      Components.interfaces.nsIWebProgressListener2,
      Components.interfaces.nsIChannelEventSink ]),

  wrappedJSObject: null,  // Initialized by constructor

  getWeakReference: function () {
    return Components.utils.getWeakReference(this);
  },

  // An "expando" is an attribute glued onto something.  From NoScript.
  getExpando: function(domWin, key) {
    var c = domWin.controllers.getControllerForCommand("https-everywhere-storage");
    try {
      if (c) {
        c = c.wrappedJSObject;
        //this.log(DBUG, "Found a controller, returning data");
        return c.data[key];
      } else {
        this.log(INFO, "No controller attached to " + domWin);
        return null;
      }
    } catch(e) {
      // Firefox 3.5
      this.log(WARN,"exception in getExpando");
      this.getExpando = this.getExpando_old;
      this.setExpando = this.setExpando_old;
      return this.getExpando_old(domWin, key, null);
    }
  },
  setExpando: function(domWin, key, value) {
    var c = domWin.controllers.getControllerForCommand("https-everywhere-storage");
    try {
      if (!c) {
        this.log(DBUG, "Appending new StorageController for " + domWin);
        c = new StorageController("https-everywhere-storage");
        domWin.controllers.appendController(c);
      } else {
        c = c.wrappedJSObject;
      }
      c.data[key] = value;
    } catch(e) {
      this.log(WARN,"exception in setExpando");
      this.getExpando = this.getExpando_old;
      this.setExpando = this.setExpando_old;
      this.setExpando_old(domWin, key, value);
    }
  },

  // This method is straight out of NoScript... we fall back to it in FF 3.*?
  getExpando_old: function(domWin, key, defValue) {
    var domObject = domWin.document;
    return domObject && domObject.__httpsEStorage && domObject.__httpsEStorage[key] || 
           (defValue ? this.setExpando(domObject, key, defValue) : null);
  },
  setExpando_old: function(domWin, key, value) {
    var domObject = domWin.document;
    if (!domObject) return null;
    if (!domObject.__httpsEStorage) domObject.__httpsEStorage = {};
    if (domObject.__httpsEStorage) domObject.__httpsEStorage[key] = value;
    else this.log(WARN, "Warning: cannot set expando " + key + " to value " + value);
    return value;
  },

  // This function is registered solely to detect favicon loads by virtue
  // of their failure to pass through this function.
  onStateChange: function(wp, req, stateFlags, status) {
    if (stateFlags & WP_STATE_START) {
      if (req instanceof CI.nsIChannel) {
        if (req instanceof CI.nsIHttpChannel) {
          PolicyState.attach(req);
        }
      }
    }
  },

  // We use onLocationChange to make a fresh list of rulesets that could have
  // applied to the content in the current page (the "applicable list" is used
  // for the context menu in the UI).  This will be appended to as various
  // content is embedded / requested by JavaScript.
  onLocationChange: function(wp, req, uri) {
    if (wp instanceof CI.nsIWebProgress) {
      if (!this.newApplicableListForDOMWin(wp.DOMWindow)) 
        this.log(WARN,"Something went wrong in onLocationChange");
    } else {
      this.log(WARN,"onLocationChange: no nsIWebProgress");
    }
  },

  getWindowForChannel: function(channel) {
    // Obtain an nsIDOMWindow from a channel
    try {
      var nc = channel.notificationCallbacks ? channel.notificationCallbacks : channel.loadGroup.notificationCallbacks;
    } catch(e) {
      this.log(WARN,"no loadgroup notificationCallbacks for "+channel.URI.spec);
      return null;
    }
    if (!nc) {
      this.log(DBUG, "no window for " + channel.URI.spec);
      return null;
    } 
    try {
      var domWin = nc.getInterface(CI.nsIDOMWindow);
    } catch(e) {
      this.log(INFO, "exploded getting DOMWin for " + channel.URI.spec);
      return null;
    }
    if (!domWin) {
      this.log(WARN, "failed to get DOMWin for " + channel.URI.spec);
      return null;
    }
    domWin = domWin.top;
    return domWin
  },

  // the lists get made when the urlbar is loading something new, but they
  // need to be appended to with reference only to the channel
  getApplicableListForChannel: function(channel) {
    var domWin = this.getWindowForChannel(channel);
    return this.getApplicableListForDOMWin(domWin, "on-modify-request w " + domWin);
  },

  newApplicableListForDOMWin: function(domWin) {
    if (!domWin || !(domWin instanceof CI.nsIDOMWindow)) {
      this.log(WARN, "Get alist without domWin");
      return null;
    }
    var dw = domWin.top;
    var alist = new ApplicableList(this.log,dw.document,dw);
    this.setExpando(dw,"applicable_rules",alist);
    return alist;
  },

  getApplicableListForDOMWin: function(domWin, where) {
    if (!domWin || !(domWin instanceof CI.nsIDOMWindow)) {
      //this.log(WARN, "Get alist without domWin");
      return null;
    }
    var dw = domWin.top;
    var alist= this.getExpando(dw,"applicable_rules",null);
    if (alist) {
      //this.log(DBUG,"get AL success in " + where);
      return alist;
    } else {
      //this.log(DBUG, "Making new AL in getApplicableListForDOMWin in " + where);
      alist = new ApplicableList(this.log,dw.document,dw);
      this.setExpando(dw,"applicable_rules",alist);
    }
    return alist;
  },


  observe: function(subject, topic, data) {
    // Top level glue for the nsIObserver API
    var channel = subject;
    //this.log(VERB,"Got observer topic: "+topic);

    if (topic == "http-on-modify-request") {
      if (!(channel instanceof CI.nsIHttpChannel)) return;
      this.log(DBUG,"Got http-on-modify-request: "+channel.URI.spec);
      var lst = this.getApplicableListForChannel(channel);
      if (channel.URI.spec in https_everywhere_blacklist) {
        this.log(DBUG, "Avoiding blacklisted " + channel.URI.spec);
        lst.breaking_rule(https_everywhere_blacklist[channel.URI.spec]);
        return;
      }
      HTTPS.replaceChannel(lst, channel);
    } else if (topic == "http-on-examine-response") {
      this.log(DBUG, "Got http-on-examine-response @ "+ (channel.URI ? channel.URI.spec : '') );
      HTTPS.handleSecureCookies(channel);
    } else if (topic == "http-on-examine-merged-response") {
      this.log(DBUG, "Got http-on-examine-merged-response ");
      HTTPS.handleSecureCookies(channel);
    } else if (topic == "app-startup") {
      this.log(DBUG,"Got app-startup");
    } else if (topic == "profile-before-change") {
      this.log(INFO, "Got profile-before-change");
      var catman = Components.classes["@mozilla.org/categorymanager;1"]
           .getService(Components.interfaces.nsICategoryManager);
      catman.deleteCategoryEntry("net-channel-event-sinks", SERVICE_CTRID, true);
      Thread.hostRunning = false;
    } else if (topic == "profile-after-change") {
      this.log(DBUG, "Got profile-after-change");
      OS.addObserver(this, "http-on-modify-request", false);
      OS.addObserver(this, "http-on-examine-merged-response", false);
      OS.addObserver(this, "http-on-examine-response", false);
      var dls = CC['@mozilla.org/docloaderservice;1']
        .getService(CI.nsIWebProgress);
      dls.addProgressListener(this, CI.nsIWebProgress.NOTIFY_STATE_REQUEST |
                                    CI.nsIWebProgress.NOTIFY_LOCATION);
      this.log(INFO,"ChannelReplacement.supported = "+ChannelReplacement.supported);
      try {
        // Firefox >= 4
        Components.utils.import("resource://gre/modules/AddonManager.jsm");
        AddonManager.getAddonByID("https-everywhere@eff.org",
          function(addon) {
            RuleWriter.addonDir = addon.
              getResourceURI("").QueryInterface(CI.nsIFileURL).file;
            HTTPSRules.init();
          });
      } catch(e) {
        // Firefox < 4
        HTTPSRules.init();
      }
      Thread.hostRunning = true;
      var catman = Components.classes["@mozilla.org/categorymanager;1"]
           .getService(Components.interfaces.nsICategoryManager);
      // hook on redirections (non persistent, otherwise crashes on 1.8.x)
      catman.addCategoryEntry("net-channel-event-sinks", SERVICE_CTRID,
          SERVICE_CTRID, false, true);
    } else if (topic == "sessionstore-windows-restored") {
      var ssl_observatory = CC["@eff.org/ssl-observatory;1"]
                        .getService(Components.interfaces.nsISupports)
                        .wrappedJSObject;
      // FIXME This prefs code is terrible spaghetti
      var shown = ssl_observatory.myGetBoolPref("popup_shown");
      // this is relevant if the user just installed torbutton bad had
      // enabled the Observatory previously
      var enabled = ssl_observatory.myGetBoolPref("enabled");
      if (!shown && !enabled && ssl_observatory.torbutton_installed) 
        this.chrome_opener("chrome://https-everywhere/content/observatory-popup.xul");
    }
    return;
  },

  // nsIChannelEventSink implementation
  onChannelRedirect: function(oldChannel, newChannel, flags) {
    const uri = newChannel.URI;
    this.log(DBUG,"Got onChannelRedirect.");
    if (!(newChannel instanceof CI.nsIHttpChannel)) {
      this.log(DBUG, newChannel + " is not an instance of nsIHttpChannel");
      return;
    }
    var alist = this.juggleApplicableListsDuringRedirection(oldChannel, newChannel);
    HTTPS.replaceChannel(alist,newChannel);
  },

  juggleApplicableListsDuringRedirection: function(oldChannel, newChannel) {
    // If the new channel doesn't yet have a list of applicable rulesets, start
    // with the old one because that's probably a better representation of how
    // secure the load process was for this page
    var domWin = this.getWindowForChannel(oldChannel);
    var old_alist = null;
    if (domWin) 
      old_alist = this.getExpando(domWin,"applicable_rules", null);
    domWin = this.getWindowForChannel(newChannel);
    if (!domWin) return null;
    var new_alist = this.getExpando(domWin,"applicable_rules", null);
    if (old_alist && !new_alist) {
      new_alist = old_alist;
      this.setExpando(domWin,"applicable_rules",new_alist);
    } else if (!new_alist) {
      new_alist = new ApplicableList(this.log, domWin.document, domWin);
      this.setExpando(domWin,"applicable_rules",new_alist);
    }
    return new_alist;
  },

  asyncOnChannelRedirect: function(oldChannel, newChannel, flags, callback) {
    this.onChannelRedirect(oldChannel, newChannel, flags);
    callback.onRedirectVerifyCallback(0);
  },

  // These implement the nsIContentPolicy API; they allow both yes/no answers
  // to "should this load?", but also allow us to change the thing.

  shouldLoad: function(aContentType, aContentLocation, aRequestOrigin, aContext, aMimeTypeGuess, aInternalCall) {
    if (aContentType == 11) {
      try {
        this.log(DBUG, "shouldLoad: "+aContentLocation.spec);
      } catch(e) {
        this.log(DBUG,"shouldLoad exception");
      }
    }
    var unwrappedLocation = IOUtil.unwrapURL(aContentLocation);
    var scheme = unwrappedLocation.scheme;
    var isHTTP = /^https?$/.test(scheme);   // s? -> either http or https
    this.log(VERB,"shoulLoad for " + aContentLocation.spec);
    if (isHTTP)
      HTTPS.forceURI(aContentLocation, null, aContext);
    return true;
  },

  shouldProcess: function(aContentType, aContentLocation, aRequestOrigin, aContext, aMimeType, aExtra) {
    return this.shouldLoad(aContentType, aContentLocation, aRequestOrigin, aContext, aMimeType, CP_SHOULDPROCESS);
  },

  get_prefs: function() {
      // get our preferences branch object
      // FIXME: Ugly hack stolen from https
      var branch_name = "extensions.https_everywhere.";
      var o_prefs = false;
      var o_branch = false;
      // this function needs to be called from inside https_everywhereLog, so
      // it needs to do its own logging...
      var econsole = Components.classes["@mozilla.org/consoleservice;1"]
          .getService(Components.interfaces.nsIConsoleService);

      o_prefs = Components.classes["@mozilla.org/preferences-service;1"]
                          .getService(Components.interfaces.nsIPrefService);

      if (!o_prefs)
      {
          econsole.logStringMessage("HTTPS Everywhere: Failed to get preferences-service!");
          return false;
      }

      o_branch = o_prefs.getBranch(branch_name);
      if (!o_branch)
      {
          econsole.logStringMessage("HTTPS Everywhere: Failed to get prefs branch!");
          return false;
      }

      // make sure there's an entry for our log level
      try {
        o_branch.getIntPref(LLVAR);
      } catch (e) {
        econsole.logStringMessage("Creating new about:config https_everywhere.LogLevel variable");
        o_branch.setIntPref(LLVAR, WARN);
      }

      return o_branch;
  },

  /**
   * Notify observers of the topic OBSERVER_TOPIC_URI_REWRITE.
   *
   * @param nsIURI oldURI
   * @param string newSpec
   */
  notifyObservers: function(oldURI, newSpec) {
    this.log(INFO, "Notifying observers of rewrite from " + oldURI.spec + " to " + newSpec);
    try {
      // The subject has to be an nsISupports and the extra data is a string,
      // that's why one is an nsIURI and the other is a nsIURI.spec string.
      this.obsService.notifyObservers(oldURI, OBSERVER_TOPIC_URI_REWRITE, newSpec);
    } catch (e) {
      this.log(WARN, "Couldn't notify observers: " + e);
    }
  },

  chrome_opener: function(uri) {
    // we don't use window.open, because we need to work around TorButton's 
    // state control
    return CC['@mozilla.org/appshell/window-mediator;1']
      .getService(CI.nsIWindowMediator) 
      .getMostRecentWindow('navigator:browser')
      .open(uri,'', 'chrome,centerscreen' );
  }

};

var prefs = 0;
var econsole = 0;
function https_everywhereLog(level, str) {
  if (prefs == 0) {
    prefs = HTTPSEverywhere.instance.get_prefs();
    econsole = Components.classes["@mozilla.org/consoleservice;1"]
               .getService(Components.interfaces.nsIConsoleService);
  } 
  try {
    var threshold = prefs.getIntPref(LLVAR);
  } catch (e) {
    econsole.logStringMessage( "HTTPS Everywhere: Failed to read about:config LogLevel");
    threshold = WARN;
  }
  if (level >= threshold) {
    dump(str+"\n");
    econsole.logStringMessage("HTTPS Everywhere: " +str);
  }
}

/**
* XPCOMUtils.generateNSGetFactory was introduced in Mozilla 2 (Firefox 4).
* XPCOMUtils.generateNSGetModule is for Mozilla 1.9.2 (Firefox 3.6).
*/
if (XPCOMUtils.generateNSGetFactory)
    var NSGetFactory = XPCOMUtils.generateNSGetFactory([HTTPSEverywhere]);
else
    var NSGetModule = XPCOMUtils.generateNSGetModule([HTTPSEverywhere]);
