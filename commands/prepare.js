/**
 * Prepare command
 * @module commands/prepare
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const ini = require('ini');
const net = require('net');
const uuid = require('uuid');
const SocketWrapper = require('socket-wrapper');

/**
 * Command class
 */
class Prepare {
    /**
     * Create the service
     * @param {App} app                 The application
     * @param {object} config           Configuration
     * @param {Runner} runner           Runner service
     */
    constructor(app, config, runner) {
        this._app = app;
        this._config = config;
        this._runner = runner;
    }

    /**
     * Service name is 'commands.prepare'
     * @type {string}
     */
    static get provides() {
        return 'commands.prepare';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'runner' ];
    }

    /**
     * Run the command
     * @param {string[]} argv           Arguments
     * @return {Promise}
     */
    run(argv) {
        return Promise.resolve()
            .then(() => {
                let configDir;
                if (os.platform() === 'freebsd') {
                    configDir = '/usr/local/etc/bhdir';
                    this._app.debug(`Platform: FreeBSD`);
                } else {
                    configDir = '/etc/bhdir';
                    this._app.debug(`Platform: Linux`);
                }

                let bhdirConfig = ini.parse(fs.readFileSync(path.join(configDir, 'bhdir.conf'), 'utf8'));
                let rootDir = bhdirConfig.directory && bhdirConfig.directory.root;
                if (!rootDir)
                    throw new Error('No root parameter in directory section of bhdir.conf');
                let user = (bhdirConfig.directory && bhdirConfig.directory.user) || 'root';
                let group = (bhdirConfig.directory && bhdirConfig.directory.group) || (os.platform() === 'freebsd' ? 'wheel' : 'root');

                return Promise.all([
                        this._runner.exec('chown', [ '-R', `${user}:${group}`, rootDir ]),
                        this._runner.exec('chmod', [ '-R', 'ug+rwX', rootDir ]),
                    ]);
            })
            .then(([ chown, chmod ]) => {
                if (chown.code !== 0)
                    this._app.error('Could not chown\n');
                if (chmod.code !== 0)
                    this._app.error('Could not chmod\n');

                let request = {
                    id: uuid.v1(),
                    command: 'clear-cache',
                };

                return this.send(Buffer.from(JSON.stringify(request), 'utf8'), argv['z'])
                    .then(reply => {
                        let response = JSON.parse(reply.toString());
                        if (response.id !== request.id)
                            throw new Error('Invalid reply from daemon');

                        if (!response.success)
                            throw new Error(`Error: ${response.message}`);

                        process.exit(0);
                    });
            })
            .catch(error => {
                return this.error(error.message);
            });
    }

    /**
     * Send request and return response
     * @param {Buffer} request
     * @param {string} [sockName]
     * @return {Promise}
     */
    send(request, sockName) {
        return new Promise((resolve, reject) => {
            let sock;
            if (sockName && sockName[0] === '/')
                sock = sockName;
            else
                sock = path.join('/var', 'run', this._config.project, this._config.instance + (sockName || '') + '.sock');

            let onError = error => {
                this.error(`Could not connect to daemon: ${error.message}`);
            };

            let socket = net.connect(sock, () => {
                this._app.debug('Connected to daemon');
                socket.removeListener('error', onError);
                socket.once('error', error => { this.error(error.message) });

                let wrapper = new SocketWrapper(socket);
                wrapper.on('receive', data => {
                    this._app.debug('Got daemon reply');
                    resolve(data);
                    socket.end();
                });
                wrapper.send(request);
            });
            socket.on('error', onError);
        });
    }

    /**
     * Log error and terminate
     * @param {...*} args
     */
    error(...args) {
        if (args.length)
            args[args.length - 1] = args[args.length - 1] + '\n';

        return this._app.error(...args)
            .then(
                () => {
                    process.exit(1);
                },
                () => {
                    process.exit(1);
                }
            );
    }
}

module.exports = Prepare;