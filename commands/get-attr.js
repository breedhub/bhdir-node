/**
 * Get Attr command
 * @module commands/get-attr
 */
const path = require('path');
const net = require('net');
const uuid = require('uuid');
const argvParser = require('argv');
const SocketWrapper = require('socket-wrapper');
const Table = require('easy-table');

/**
 * Command class
 */
class GetAttr {
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
     * Service name is 'commands.getAttr'
     * @type {string}
     */
    static get provides() {
        return 'commands.getAttr';
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
                name: 'output',
                short: 'o',
                type: 'string',
            })
            .option({
                name: 'no-header',
                short: 'n',
                type: 'boolean',
            })
            .option({
                name: 'socket',
                short: 'z',
                type: 'string',
            })
            .run(argv);

        if (args.targets.length < 2)
            return this._help.helpGetAttr(argv);

        let getPath = args.targets[1];
        let getName = args.targets.length >= 3 ? args.targets[2] : null;

        let request = {
            id: uuid.v1(),
            command: 'get-attr',
            args: [
                getPath,
                getName
            ]
        };

        return this.send(Buffer.from(JSON.stringify(request), 'utf8'), args.options['socket'])
            .then(reply => {
                let response = JSON.parse(reply.toString());
                if (response.id !== request.id)
                    throw new Error('Invalid reply from daemon');

                if (!response.success)
                    throw new Error(`Error: ${response.message}`);

                return Promise.resolve()
                    .then(() => {
                        if (getName) {
                            return this._app.info(
                                (typeof response.results[0] === 'object' ?
                                    JSON.stringify(response.results[0]) :
                                    response.results[0]) + '\n');
                        }

                        let output = '';
                        if ((args.options['output'] || 'table') === 'table') {
                            if (args.options['no-header']) {
                                for (let key of Object.keys(response.results[0])) {
                                    output += key + ' ' + (typeof response.results[0][key] === 'object' ?
                                            JSON.stringify(response.results[0][key]) :
                                            response.results[0][key]) + '\n';
                                }
                            } else {
                                let table = new Table();
                                for (let key of Object.keys(response.results[0])) {
                                    table.cell('Name', key);
                                    table.cell('Value', (typeof response.results[0][key] === 'object' ?
                                        JSON.stringify(response.results[0][key]) :
                                        response.results[0][key]));
                                    table.newRow();
                                }
                                output = table.toString();
                            }
                        } else {
                            output = JSON.stringify(response.results[0], undefined, 4);
                        }

                        output = output.trim();
                        if (output.length)
                            return this._app.info(output + '\n');
                    })
                    .then(() => {
                        return response.results[0] === null ? 10 : 0;
                    });
            })
            .then(code => {
                process.exit(code);
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

module.exports = GetAttr;