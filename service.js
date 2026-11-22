// Salon TV service loader (TizenBrew runs this file). It asks GitHub for the newest commit,
// downloads service-core.js pinned to that commit from jsDelivr and runs it. If anything
// fails it runs the copy bundled below, so the service always starts.
var https = require('https');
function salonBundledCore() {
// Salon TV background service. Runs inside TizenBrew's Node (v4, ES5 only) with TizenBrew's
// Tizen privileges, so it can open other apps for the start screen page.
// Listens on 127.0.0.1:8090:
//   /launch?id=<appId>   open an app and watch it
//   /apps                installed apps (id, name)
//   /return?on=1|0       turn "return to Salon TV" on/off (no "on" = toggle)
//   /status, /ping
//
// Return to Salon TV: after an app we opened has been running, if it stops running
// (the user backed out of it), bring TizenBrew to the front; its autolaunch shows Salon TV.
// If the app is only hidden (Home / Source pressed) it keeps running, so we leave it alone.
var http = require('http');
var url = require('url');
var fs = require('fs');

var TIZENBREW_ID = 'xvvl3S1bvH.TizenBrewStandalone';
var SETTINGS_FILE = '/home/owner/share/salontv.json';
var POLL_MS = 2000;
var WATCH_MAX_MS = 8 * 60 * 60 * 1000;

var settings = { returnHome: true };
try { var saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); if (typeof saved.returnHome === 'boolean') settings.returnHome = saved.returnHome; } catch (e) {}
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch (e) {} }

var watched = {};   // appId -> { seen: bool, since: ms }
var lastEvent = '';

function send(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
}

function tvRequest(method, path, cb) {
    var req = http.request({ host: '127.0.0.1', port: 8001, method: method, path: path }, function (r) {
        var body = '';
        r.on('data', function (c) { body += c; });
        r.on('end', function () { cb(null, r.statusCode, body); });
    });
    req.on('error', function (e) { cb(e); });
    req.setTimeout(4000, function () { req.abort(); });
    req.end();
}

function restLaunch(id, cb) {
    tvRequest('POST', '/api/v2/applications/' + id, function (err, code, body) {
        cb(err ? ('rest ' + err.message) : (code === 200 ? null : ('rest ' + code + ' ' + body)));
    });
}

function launch(id, cb) {
    var done = false;
    function finish(err) { if (!done) { done = true; cb(err); } }
    try {
        tizen.application.launch(id, function () { finish(null); }, function (e) {
            restLaunch(id, function (err2) { finish(err2 ? ('tizen ' + (e && e.name) + '; ' + err2) : null); });
        });
    } catch (e) {
        restLaunch(id, function (err2) { finish(err2 ? ('tizen ' + e.message + '; ' + err2) : null); });
    }
    setTimeout(function () { finish('timeout'); }, 8000);
}

function tvIsOn(cb) {
    tvRequest('GET', '/api/v2/', function (err, code, body) {
        if (err || code !== 200) return cb(false);
        try { cb(JSON.parse(body).device.PowerState === 'on'); } catch (e) { cb(false); }
    });
}

function bringHome() {
    try {
        tizen.application.launch(TIZENBREW_ID, function () { lastEvent = 'returned ' + new Date().toISOString(); },
            function (e) { lastEvent = 'return failed ' + (e && e.name); });
    } catch (e) { lastEvent = 'return failed ' + e.message; }
}

function poll() {
    var ids = Object.keys(watched);
    ids.forEach(function (id) {
        var w = watched[id];
        if (Date.now() - w.since > WATCH_MAX_MS) { delete watched[id]; return; }
        tvRequest('GET', '/api/v2/applications/' + id, function (err, code, body) {
            if (err || code !== 200 || !watched[id]) return;
            var info; try { info = JSON.parse(body); } catch (e) { return; }
            if (info.running) { w.seen = true; return; }
            if (!w.seen) return;                     // still starting up
            delete watched[id];                      // the user left the app
            if (!settings.returnHome) return;
            // confirm twice, 1.5s apart, and only while the screen is on
            setTimeout(function () {
                tvRequest('GET', '/api/v2/applications/' + id, function (err2, code2, body2) {
                    var again; try { again = JSON.parse(body2); } catch (e) { again = null; }
                    if (err2 || !again || again.running) return;
                    tvIsOn(function (on) { if (on) bringHome(); });
                });
            }, 1500);
        });
    });
}
setInterval(poll, POLL_MS);

var server = http.createServer(function (req, res) {
    var u = url.parse(req.url, true);
    if (u.pathname === '/ping') return send(res, 200, { ok: true });
    if (u.pathname === '/status') return send(res, 200, { ok: true, returnHome: settings.returnHome, watching: Object.keys(watched), lastEvent: lastEvent });
    if (u.pathname === '/return') {
        if (u.query.on === '1') settings.returnHome = true;
        else if (u.query.on === '0') settings.returnHome = false;
        else settings.returnHome = !settings.returnHome;
        saveSettings();
        return send(res, 200, { ok: true, returnHome: settings.returnHome });
    }
    if (u.pathname === '/launch') {
        var id = String(u.query.id || '');
        if (!/^[A-Za-z0-9._-]+$/.test(id)) return send(res, 400, { ok: false, error: 'bad id' });
        return launch(id, function (err) {
            if (!err) watched[id] = { seen: false, since: Date.now() };
            send(res, 200, err ? { ok: false, error: err } : { ok: true });
        });
    }
    if (u.pathname === '/apps') {
        try {
            return tizen.application.getAppsInfo(function (list) {
                var out = [];
                for (var i = 0; i < list.length; i++) out.push({ id: list[i].id, name: list[i].name });
                send(res, 200, { ok: true, apps: out });
            }, function (e) { send(res, 200, { ok: false, error: String(e && e.name) }); });
        } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }
    send(res, 404, { ok: false });
});
server.on('error', function () { /* port already taken by an earlier copy: that copy keeps serving */ });
server.listen(8090, '127.0.0.1');

}
function salonGet(opts, cb) {
    var done = false;
    function fin(v) { if (!done) { done = true; cb(v); } }
    try {
        var req = https.get(opts, function (r) {
            var b = '';
            r.on('data', function (c) { b += c; });
            r.on('end', function () { fin(r.statusCode === 200 ? b : null); });
        });
        req.on('error', function () { fin(null); });
        req.setTimeout(6000, function () { req.abort(); fin(null); });
    } catch (e) { fin(null); }
}
(function () {
    var started = false;
    function run(code) {
        if (started) return; started = true;
        if (code) { try { eval(code); return; } catch (e) { /* fall through to bundled */ } }
        salonBundledCore();
    }
    setTimeout(function () { run(null); }, 12000);
    salonGet({ host: 'api.github.com', path: '/repos/Zalylex/salon-tv/commits/main',
               headers: { 'User-Agent': 'salon-tv', 'Accept': 'application/vnd.github.sha' } }, function (sha) {
        sha = (sha || '').trim();
        if (!/^[0-9a-f]{40}$/.test(sha)) return run(null);
        salonGet({ host: 'cdn.jsdelivr.net', path: '/gh/Zalylex/salon-tv@' + sha + '/service-core.js' }, function (code) { run(code); });
    });
})();
