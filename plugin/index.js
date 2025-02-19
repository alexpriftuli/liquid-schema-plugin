const fs = require('fs-extra');
const path = require('path');
const validate = require('schema-utils');
const { RawSource } = require('webpack-sources');
const { asString } = require('webpack').Template;

const optionsSchema = require('./schema');

const PLUGIN_NAME = 'Liquid Schema Plugin';

module.exports = class LiquidSchemaPlugin {
    constructor(options = {}) {
        validate(optionsSchema, options, { name: PLUGIN_NAME });
        this.options = options;
    }

    apply(compiler) {
        const isWebpack4 = !compiler.webpack;

        if (isWebpack4) {
            compiler.hooks.emit.tapPromise(
                PLUGIN_NAME,
                this.buildSchema.bind(this)
            );

            return;
        }

        compiler.hooks.thisCompilation.tap(PLUGIN_NAME, compilation => {
            compilation.hooks.processAssets.tapPromise(
                PLUGIN_NAME,
                this.buildSchema.bind(this, compilation)
            );
        });
    }

    async buildSchema(compilation) {
        const files = await fs.readdir(this.options.from.liquid);
        const compilationOutput = compilation.compiler.outputPath;

        compilation.contextDependencies.add(this.options.from.liquid);
        compilation.contextDependencies.add(this.options.from.schema);

        const preTransformCache = [...Object.keys(require.cache)];

        return Promise.all(
            files.map(async file => {
                const fileLocation = path.resolve(
                    this.options.from.liquid,
                    file
                );
                const fileStat = await fs.stat(fileLocation);

                if (fileStat.isFile() && path.extname(file) === '.liquid') {
                    const relativeFilePath = path.relative(
                        compilation.options.context,
                        fileLocation
                    );

                    const outputKey = this.getOutputKey(
                        fileLocation,
                        compilationOutput
                    );

                    try {
                        let outputFile = await this.replaceSchemaTags(
                            fileLocation,
                            compilation
                        );

                        const duplicateRules = this.constructor.getDuplicateRules(
                            // eslint-disable-next-line no-underscore-dangle
                            outputFile._value
                        );

                        if (duplicateRules) {
                            outputFile = await this.constructor.cleanDupicateTag(
                                outputFile
                            );

                            // eslint-disable-next-line no-param-reassign
                            compilation.assets = await this.duplicatedFiles(
                                compilationOutput,
                                duplicateRules,
                                outputFile,
                                compilation.assets
                            );
                        } else {
                            // eslint-disable-next-line no-param-reassign
                            compilation.assets[outputKey] = outputFile;
                        }
                    } catch (error) {
                        compilation.errors.push(
                            new Error(`./${relativeFilePath}\n\n${error}`)
                        );
                    }
                }
            })
        ).then(() => {
            const postTransformCache = [...Object.keys(require.cache)];
            postTransformCache
                .filter(module => !preTransformCache.includes(module))
                .forEach(module => {
                    compilation.contextDependencies.add(path.dirname(module));
                    compilation.fileDependencies.add(module);
                    delete require.cache[module];
                });
        });
    }

    getOutputKey(liquidSourcePath, compilationOutput) {
        const fileName = path.relative(
            this.options.from.liquid,
            liquidSourcePath
        );

        return this.getOutputKeyByFileName(fileName, compilationOutput);
    }

    getOutputKeyByFileName(fileName, compilationOutput) {
        const relativeOutputPath = path.relative(
            compilationOutput,
            this.options.to
        );

        return path.join(relativeOutputPath, fileName);
    }

    async replaceSchemaTags(fileLocation, compilation) {
        const fileName = path.basename(fileLocation, '.liquid');
        const fileContents = await fs.readFile(fileLocation, 'utf-8');
        const replaceableSchemaRegex = /{%-?\s*schema\s*('.*'|".*")\s*-?%}(([\s\S]*){%-?\s*endschema\s*-?%})?/;
        const fileContainsReplaceableSchemaRegex = replaceableSchemaRegex.test(
            fileContents
        );

        if (!fileContainsReplaceableSchemaRegex) {
            return new RawSource(fileContents);
        }

        // eslint-disable-next-line prefer-const
        let [match, importableFilePath, , contents] = fileContents.match(
            replaceableSchemaRegex
        );
        importableFilePath = importableFilePath.replace(
            /(^('|"))|(('|")$)/g,
            ''
        );
        importableFilePath = path.resolve(
            this.options.from.schema,
            importableFilePath
        );

        compilation.fileDependencies.add(require.resolve(importableFilePath));

        let importedSchema;
        try {
            // eslint-disable-next-line global-require, import/no-dynamic-require
            importedSchema = require(importableFilePath);
        } catch (error) {
            throw [
                match,
                '^',
                `      File to import not found or unreadable: ${importableFilePath}`,
                `      in ${fileLocation}`,
            ].join('\n');
        }

        try {
            contents = JSON.parse(contents);
        } catch (error) {
            contents = null;
        }

        let schema = importedSchema;
        if (typeof importedSchema === 'function') {
            schema = importedSchema(fileName, contents);
        }

        if (typeof schema !== 'object') {
            throw [
                schema,
                '^',
                `      Schema expected to be of type "object"`,
                `      in ${require.resolve(importableFilePath)}`,
            ].join('\n');
        }

        return new RawSource(
            fileContents.replace(
                replaceableSchemaRegex,
                asString([
                    '{% schema %}',
                    JSON.stringify(schema, null, 4),
                    '{% endschema %}',
                ])
            )
        );
    }

    async duplicatedFiles(
        fileLocation,
        duplicateRules,
        fileContent,
        assetList
    ) {
        if (duplicateRules) {
            duplicateRules.forEach(newFileName => {
                const outputKey = this.getOutputKeyByFileName(
                    `${newFileName}.liquid`,
                    fileLocation
                );

                // eslint-disable-next-line no-param-reassign
                assetList[outputKey] = new RawSource(
                    // eslint-disable-next-line no-underscore-dangle
                    fileContent._value.replace("-{{title_section}}-", newFileName)
                );
;
            });
        }

        return assetList;
    }

    static async cleanDupicateTag(fileContents) {
        const replaceableSchemaRegex = /{%-?\s*duplicate\s*-?%}(([\s\S]*)){%-?\s*endduplicate\s*-?%}\n\n/;
        return new RawSource(
            // eslint-disable-next-line no-underscore-dangle
            fileContents._value.replace(replaceableSchemaRegex, '')
        );
    }

    static getDuplicateRules(fileContents) {
        const replaceableSchemaRegex = /{%-?\s*duplicate\s*-?%}(([\s\S]*)){%-?\s*endduplicate\s*-?%}/;
        const match = fileContents.match(replaceableSchemaRegex);

        if (match && match[1] !== '') {
            return JSON.parse(match[1]);
        }

        return '';
    }
};
