/**
 * Install command
 * @module commands/install
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const ini = require('ini');
const uuid = require('uuid');
const argvParser = require('argv');
const SocketWrapper = require('socket-wrapper');

/**
 * Command class
 */
class Install {
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
     * Service name is 'commands.install'
     * @type {string}
     */
    static get provides() {
        return 'commands.install';
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
        let args = argvParser
            .option({
                name: 'help',
                short: 'h',
                type: 'boolean',
            })
            .option({
                name: 'socket',
                short: 'z',
                type: 'string',
            })
            .run(argv);

        return this.install(args.options['socket'])
            .then(() => {
                process.exit(0);
            })
            .catch(error => {
                return this.error(error.message);
            });
    }

    /**
     * Install bhdir
     * @param {string} [sockName]
     * @return {Promise}
     */
    install(sockName) {
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

                try {
                    fs.accessSync(configDir, fs.constants.F_OK);
                } catch (error) {
                    try {
                        fs.mkdirSync(configDir, 0o750);
                    } catch (error) {
                        return this.error(`Could not create ${configDir}`);
                    }
                }
                try {
                    fs.accessSync('/var/run/bhdir', fs.constants.F_OK);
                } catch (error) {
                    try {
                        fs.mkdirSync('/var/run/bhdir', 0o755);
                    } catch (error) {
                        return this.error(`Could not create /var/run/bhdir`);
                    }
                }
                try {
                    fs.accessSync('/var/log/bhdir', fs.constants.F_OK);
                } catch (error) {
                    try {
                        fs.mkdirSync('/var/log/bhdir', 0o755);
                    } catch (error) {
                        return this.error(`Could not create /var/log/bhdir`);
                    }
                }
                try {
                    fs.accessSync('/var/lib/bhdir', fs.constants.F_OK);
                } catch (error) {
                    try {
                        fs.mkdirSync('/var/lib/bhdir', 0o755);
                    } catch (error) {
                        return this.error(`Could not create /var/lib/bhdir`);
                    }
                }

                try {
                    this._app.debug('Creating default config');
                    fs.accessSync(path.join(configDir, 'bhdir.conf'), fs.constants.F_OK);
                } catch (error) {
                    try {
                        let config = fs.readFileSync(path.join(__dirname, '..', 'bhdir.conf'), { encoding: 'utf8'});
                        config = config.replace(/GROUP/g, os.platform() === 'freebsd' ? 'wheel' : 'root');
                        fs.writeFileSync(path.join(configDir, 'bhdir.conf'), config, { mode: 0o640 });
                    } catch (error) {
                        console.log(error);
                        return this.error(`Could not create bhdir.conf`);
                    }
                }
                try {
                    fs.accessSync('/etc/systemd/system', fs.constants.F_OK);
                    this._app.debug('Creating systemd service');
                    let service = fs.readFileSync(path.join(__dirname, '..', 'systemd.service'), {encoding: 'utf8'});
                    fs.writeFileSync('/etc/systemd/system/bhdir.service', service, {mode: 0o644});
                } catch (error) {
                    // do nothing
                }
                try {
                    fs.accessSync('/etc/init.d', fs.constants.F_OK);
                    this._app.debug('Creating sysvinit service');
                    let service = fs.readFileSync(path.join(__dirname, '..', 'sysvinit.service'), {encoding: 'utf8'});
                    fs.writeFileSync('/etc/init.d/bhdir', service, {mode: 0o755});
                } catch (error) {
                    // do nothing
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
                    this._app.error('Could not chown root directory\n');
                if (chmod.code !== 0)
                    this._app.error('Could not chmod root directory\n');

                let request = {
                    id: uuid.v1(),
                    command: 'clear-cache',
                };

                return this.send(Buffer.from(JSON.stringify(request), 'utf8'), sockName)
                    .then(reply => {
                        let response = JSON.parse(reply.toString());
                        if (response.id !== request.id)
                            throw new Error('Invalid reply from daemon');

                        if (!response.success)
                            throw new Error(`Error: ${response.message}`);
                    });
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

module.exports = Install;