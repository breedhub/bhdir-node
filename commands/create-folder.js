/**
 * Create Folder command
 * @module commands/create-folder
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const uuid = require('uuid');
const argvParser = require('argv');
const SocketWrapper = require('socket-wrapper');

/**
 * Command class
 */
class CreateFolder {
    /**
     * Create the service
     * @param {App} app                 The application
     * @param {object} config           Configuration
     * @param {Runner} runner           Runner service
     * @param {Help} help               Help command
     * @param {Start} start             Start command
     * @param {Stop} stop               Stop command
     */
    constructor(app, config, runner, help, start, stop) {
        this._app = app;
        this._config = config;
        this._runner = runner;
        this._help = help;
        this._start = start;
        this._stop = stop;
    }

    /**
     * Service name is 'commands.createFolder'
     * @type {string}
     */
    static get provides() {
        return 'commands.createFolder';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'runner', 'commands.help', 'commands.start', 'commands.stop' ];
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
                name: 'name',
                short: 'n',
                type: 'string',
            })
            .option({
                name: 'socket',
                short: 'z',
                type: 'string',
            })
            .run(argv);

        if (args.targets.length < 2)
            return this._help.helpCreateFolder(argv);

        let dir = args.targets[1];
        let folder = args.options['name'] || path.basename(dir);

        let request = {
            id: uuid.v1(),
            command: 'create-folder',
            args: [
                folder,
                dir,
            ]
        };

        return this.send(Buffer.from(JSON.stringify(request), 'utf8'), args.options['socket'])
            .then(reply => {
                let response = JSON.parse(reply.toString());
                if (response.id !== request.id)
                    throw new Error('Invalid reply from daemon');

                if (!response.success)
                    throw new Error(`Error: ${response.message}`);

                return this._app.info(`ReadWrite: ${response.results[0]}\nReadOnly: ${response.results[1]}`);
            })
            .then(() => {
                return this._stop.terminate();
            })
            .then(() => {
                return this._start.launch();
            })
            .then(() => {
                return this._runner.exec('/etc/init.d/resilio-sync', [ 'restart' ])
                    .catch(() => {
                        // do nothing
                    });
            })
            .then(() => {
                process.exit(0);
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

module.exports = CreateFolder;