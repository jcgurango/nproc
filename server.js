const { timingSafeEqual } = require('crypto');
const { readFileSync, writeFileSync } = require('fs');
const { inspect } = require('util');
const net = require('net');
const fp = require('find-free-port');
const { exec } = require('child_process');

const { utils: { parseKey }, Server } = require('ssh2');
const clients = [];

const templateHttp = readFileSync('template_http.conf', {
  encoding: 'utf-8',
});

const render = () => {
  writeFileSync(
    'apache2.conf',
    clients
      .map(({ servername, boundport }) => templateHttp.replace(/\[servername\]/g, servername).replace(/\[boundport\]/g, boundport))
      .join('\n')
  );

  console.log(clients.length + ' clients connected, reloading apache');
  exec('service apache2 reload', (err, stdout) => {
    console.log(err, stdout);
  });
};

function checkValue(input, allowed) {
  const autoReject = (input.length !== allowed.length);
  if (autoReject) {
    // Prevent leaking length information by always making a comparison with the
    // same input when lengths don't match what we expect ...
    allowed = input;
  }
  const isMatch = timingSafeEqual(input, allowed);
  return (!autoReject && isMatch);
}

new Server({
  hostKeys: [readFileSync(require('os').homedir() + '/.ssh/id_rsa')]
}, (client) => {
  console.log('Client connected!');
  let user = null;

  client.on('authentication', (ctx) => {
    let allowed = true;
    user = ctx.username;

    if (allowed)
      ctx.accept();
    else
      ctx.reject();
  }).on('ready', () => {
    console.log('Client authenticated!');

    client
      .on('session', (accept, reject) => {
        const session = accept();
        session.once('exec', (accept, reject, info) => {
          console.log('Client wants to execute: ' + inspect(info.command));
          const stream = accept();
          stream.stderr.write('Oh no, the dreaded errors!\n');
          stream.write('Just kidding about the errors!\n');
        });

        session.on('pty', function (accept, reject, info) {
          accept();
        });
        session.on('shell', function (accept, reject) {
          var stream = accept();

          stream.on('data', (d) => {
            if (d[0] === 3) {
              stream.exit(0);
              stream.end();
            }
          })
        });
      })
      .on('request', async (accept, reject, name, info) => {
        if (name === 'tcpip-forward') {
          if (info.bindPort === 80) {
            const [realPort] = await fp(33000);
            accept();
            clients.push({
              boundport: realPort,
              servername: user,
              client,
            })
            render();

            net.createServer(function (socket) {
              socket.setEncoding('utf8');
              client.forwardOut(
                info.bindAddr, realPort,
                socket.remoteAddress, socket.remotePort,
                (err, upstream) => {
                  if (err) {
                    socket.end();
                    return console.error('not working: ' + err);
                  }
                  upstream.pipe(socket).pipe(upstream);
                });
            }).listen(realPort);
          } else {
            reject();
          }
        } else {
          reject();
        }
      });
  }).on('close', (e) => {
    clients.splice(clients.findIndex(({ client: c }) => c === client), 1);
    render();
    console.log('Client disconnected');
  }).on('error', (err) => {
    console.log(err);
  });
}).listen(2222, '0.0.0.0', function () {
  console.log('Listening on port ' + this.address().port);
});
