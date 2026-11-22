// Salon TV background service. Runs inside TizenBrew's Node (v4, ES5 only) with TizenBrew's
// Tizen privileges, so it can open other apps for the start screen page.
// Listens on 127.0.0.1:8090:  /launch?id=<appId>   /apps   /ping
var http = require('http');
var url = require('url');

function send(res, code, obj) {
    res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(obj));
}

function restLaunch(id, cb) {
    var req = http.request({ host: '127.0.0.1', port: 8001, method: 'POST', path: '/api/v2/applications/' + id }, function (r) {
        var body = '';
        r.on('data', function (c) { body += c; });
        r.on('end', function () { cb(r.statusCode === 200 ? null : ('rest ' + r.statusCode + ' ' + body)); });
    });
    req.on('error', function (e) { cb('rest ' + e.message); });
    req.end();
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

var server = http.createServer(function (req, res) {
    var u = url.parse(req.url, true);
    if (u.pathname === '/ping') return send(res, 200, { ok: true });
    if (u.pathname === '/launch') {
        var id = String(u.query.id || '');
        if (!/^[A-Za-z0-9._-]+$/.test(id)) return send(res, 400, { ok: false, error: 'bad id' });
        return launch(id, function (err) { send(res, 200, err ? { ok: false, error: err } : { ok: true }); });
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
