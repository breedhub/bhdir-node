/**
 * Upload command
 * @module commands/upload
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
class Upload {
    /**
     * Create the service
     * @param {App} app                 The application
     * @param {object} config           Configuration
     * @param {Help} help               Help command
     */
    constructor(app, config, help) {
        this._app = app;
        this._config = config;
        this._help = help;
    }

    /**
     * Service name is 'commands.upload'
     * @type {string}
     */
    static get provides() {
        return 'commands.upload';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'commands.help' ];
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

        if (args.targets.length < 3)
            return this._help.helpUpload(argv);

        let uploadFile = args.targets[1];
        let uploadPath = args.targets[2];

        return new Promise((resolve, reject) => {
                try {
                    resolve(fs.readFileSync(uploadFile, 'base64'));
                } catch (error) {
                    reject(error);
                }
            })
            .then(contents => {
                let request = {
                    id: uuid.v1(),
                    command: 'upload',
                    args: [
                        uploadPath,
                        contents,
                    ]
                };

                return this.send(Buffer.from(JSON.stringify(request), 'utf8'), args.options['socket'])
                    .then(reply => {
                        let response = JSON.parse(reply.toString());
                        if (response.id !== request.id)
                            throw new Error('Invalid reply from daemon');

                        if (!response.success)
                            throw new Error(`Error: ${response.message}`);

                        process.exit(0);
                    })
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

module.exports = Upload;