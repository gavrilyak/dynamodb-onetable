/*
    Table.js - DynamoDB table class
 */

import Crypto from 'crypto'
import ULID from './ULID.js'
import {Model} from './Model.js'

const IV_LENGTH = 16
const ConfirmRemoveTable = 'DeleteTableForever'

/*
    Default index keys if not supplied
 */
const DefaultIndexes = {
    primary: {
        hash: 'pk',
        sort: 'sk',
    },
}

/*
    Represent a single DynamoDB table
 */
export class Table {

    constructor(params = {}) {
        let {
            client,         //  Instance of DocumentClient or Dynamo. Use client.V3 to test for Dynamo V3.
            createdField,   //  Name of "created" timestamp attribute.
            crypto,         //  Crypto configuration. {primary: {cipher: 'aes-256-gcm', password}}.
            delimiter,      //  Composite sort key delimiter (default ':').
            hidden,         //  Hide key attributes in Javascript properties. Default false.
            intercept,      //  Intercept hook function(model, operation, item, params, raw). Operation: 'create', 'delete', 'put', ...
            isoDates,       //  Set to true to store dates as Javascript ISO Date strings.
            logger,         //  Logging function(tag, message, properties). Tag is data.info|error|trace|exception.
            name,           //  Table name.
            nulls,          //  Store nulls in database attributes. Default false.
            schema,         //  Table models schema.
            timestamps,     //  Make "created" and "updated" timestamps. Default true.
            typeField,      //  Name of model type attribute. Default "_type".
            updatedField,   //  Name of "updated" timestamp attribute.
            uuid,           //  Function to create a UUID, ULID, KSUID if field schema requires it.

            //  DEPRECATED
            ksuid,          //  Function to create a KSUID if field schema requires it.
            ulid,           //  Function to create a ULID if field schema requires it.
        } = params

        if (!name) {
            throw new Error('Missing "name" property')
        }
        if (!client) {
            throw new Error('Missing "client" property')
        }
        if (logger === true) {
            this.logger = this.defaultLogger
        } else {
            this.logger = logger
        }
        this.log('trace', `Loading OneTable`)

        this.params = params
        this.client = client
        this.V3 = client.V3
        this.service = this.V3 ? this.client : this.client.service

        this.createdField = createdField || 'created'
        this.delimiter = delimiter || '#'
        this.hidden = hidden != null ? hidden : true
        this.intercept = intercept
        this.isoDates = isoDates || false
        this.name = name
        this.nulls = nulls || false
        this.timestamps = timestamps != null ? timestamps : true
        this.typeField = typeField || '_type'
        this.updatedField = updatedField || 'updated'

        if (uuid == 'uuid') {
            this.makeID = this.uuid
        } else if (uuid == 'ulid') {
            this.makeID = this.ulid
        } else {
            this.makeID = uuid || this.uuid
        }

        //  DEPRECATED
        this.ulid = ulid || this.ulid
        this.ksuid = ksuid

        //  Schema models
        this.models = {}
        this.indexes = DefaultIndexes

        //  Context properties always applied to create/updates
        this.context = {}

        if (schema) {
            this.prepSchema(schema)
        }

        /*
            Model for unique attributes
         */
        let primary = this.indexes.primary
        this.unique = new Model(this, '_Unique', {
            fields: {
                [primary.hash]: { value: '_unique:${' + primary.hash + '}'},
                [primary.sort]: { value: '_unique:'},
            },
            indexes: this.indexes,
            timestamps: false
        })

        /*
            Model for genric low-level API access
         */
        this.generic = new Model(this, '_Generic', {
            fields: {
                [primary.hash]: {},
                [primary.sort]: {},
            },
            indexes: this.indexes,
            timestamps: false
        })

        if (crypto) {
            this.initCrypto(crypto)
            this.crypto = Object.assign(crypto || {})
            for (let [name, crypto] of Object.entries(this.crypto)) {
                crypto.secret = Crypto.createHash('sha256').update(crypto.password, 'utf8').digest()
                this.crypto[name] = crypto
                this.crypto[name].name = name
            }
        }
    }

    setClient(client) {
        this.client = client
        this.V3 = client.V3
    }

    //  Return the current schema. This may include model schema defined at run-time
    getSchema() {
        let schema = {name: this.name, models: {}, indexes: this.indexes}
        for (let [name, model] of Object.entries(this.models)) {
            let item = {}
            for (let [field, properties] of Object.entries(model.fields)) {
                item[field] = {
                    crypt: properties.crypt,
                    enum: properties.enum,
                    filter: properties.filter,
                    foreign: properties.foreign,
                    hidden: properties.hidden,
                    map: properties.map,
                    name: field,
                    nulls: properties.nulls,
                    required: properties.required,
                    size: properties.size,
                    type: (typeof properties.type == 'function') ? properties.type.name : properties.type,
                    unique: properties.unique,
                    validate: properties.validate ? properties.validate.toString() : null,
                    value: properties.value,

                    //  Computed state
                    attribute: properties.attribute,    //  Attribute 'map' name
                    isIndexed: properties.isIndexed,
                }
            }
            schema.models[name] = item
        }
        return schema
    }

    prepSchema(params) {
        let {models, indexes} = params
        if (!models || typeof models != 'object') {
            throw new Error('Schema is missing models')
        }
        if (!indexes || typeof indexes != 'object') {
            throw new Error('Schema is missing indexes')
        }
        this.indexes = indexes
        for (let [name, fields] of Object.entries(models)) {
            this.models[name] = new Model(this, name, {fields, indexes})
        }
    }

    /*
        Create a table. Params may contain standard DynamoDB createTable parameters
    */
    async createTable(params = {}) {
        let def = {
            AttributeDefinitions: [],
            KeySchema: [],
            LocalSecondaryIndexes: [],
            GlobalSecondaryIndexes: [],
            TableName: this.name,
        }
        let provisioned = params.ProvisionedThroughput
        if (provisioned) {
            def.ProvisionedThroughput = provisioned
            def.BillingMode = 'PROVISIONED'
        } else {
            def.BillingMode = 'PAY_PER_REQUEST'
        }
        let indexes = this.indexes
        for (let [name, index] of Object.entries(indexes)) {
            let collection, keys
            if (name == 'primary') {
                keys = def.KeySchema
            } else {
                if (index.hash == null || index.hash == indexes.primary.hash) {
                    collection = LocalSecondaryIndexes
                } else {
                    collection = 'GlobalSecondaryIndexes'
                }
                keys = []
                let project, attributes
                if (Array.isArray(index.project)) {
                    project = 'INCLUDE'
                    attributes = index.project
                } else if (index.project == 'keys') {
                    project = 'KEYS_ONLY'
                } else {
                    project = 'ALL'
                }
                def[collection].push({
                    IndexName: name,
                    KeySchema: keys,
                    Projection: {
                        NonKeyAttributes: attributes,
                        ProjectionType: project,
                    }
                })
            }
            def.AttributeDefinitions.push({
                AttributeName: index.hash,
                AttributeType: 'S',
            })
            def.AttributeDefinitions.push({
                AttributeName: index.sort,
                AttributeType: 'S',
            })
            keys.push({
                AttributeName: index.hash || indexes.primary.hash,
                KeyType: 'HASH',
            })
            keys.push({
                AttributeName: index.sort,
                KeyType: 'RANGE',
            })
        }
        if (def.GlobalSecondaryIndexes.length == 0) {
            delete def.GlobalSecondaryIndexes
        }
        if (def.LocalSecondaryIndexes.length == 0) {
            delete def.LocalSecondaryIndexes
        }
        this.log('info', `Dynamo createTable for "${this.name}"`, {def})
        if (this.V3) {
            return await this.service.createTable(def)
        } else {
            return await this.service.createTable(def).promise()
        }
    }

    async deleteTable(confirmation) {
        if (confirmation == ConfirmRemoveTable) {
            this.log('info', `Dynamo deleteTable for "${this.name}"`)
            if (this.V3) {
                await this.service.deleteTable({TableName: this.name})
            } else {
                await this.service.deleteTable({TableName: this.name}).promise()
            }
        } else {
            throw new Error(`Missing required confirmation "${ConfirmRemoveTable}"`)
        }
    }

    async describeTable() {
        if (this.V3) {
            return await this.service.describeTable({TableName: this.name})
        } else {
            return await this.service.describeTable({TableName: this.name}).promise()
        }
    }

    async exists() {
        let results
        if (this.V3) {
            results = await this.service.listTables({})
        } else {
            results = await this.service.listTables({}).promise()
        }
        return results && results.TableNames.find(t => t == this.name)
    }

    listModels() {
        return Object.keys(this.models)
    }

    addModel(name, fields) {
        this.models[name] = new Model(this, name, {indexes: schema.indexes, fields})
    }

    /*
        Thows exception if model cannot be found
     */
    getModel(name) {
        if (typeof name != 'string') {
            throw new Error(`Bad argument type for model name ${name}`)
        }
        let model = this.models[name]
        if (!model) {
            throw new Error(`Cannot find model ${name}`)
        }
        return model
    }

    removeModel(name) {
        if (this.getModel(name)) {
            delete this.models[name]
        }
    }

    /*
        Set or update the context object. Return this for chaining.
     */
    setContext(context = {}, merge = false) {
        this.context = merge ? Object.assign(this.context, context) : context
        return this
    }

    /*
        Clear the context
     */
    clear() {
        this.context = {}
        return this
    }

    //  High level model factory API

    async create(modelName, properties, params) {
        let model = this.getModel(modelName)
        return await model.create(properties, params)
    }

    async find(modelName, properties, params) {
        let model = this.getModel(modelName)
        return await model.find(properties, params)
    }

    async get(modelName, properties, params) {
        let model = this.getModel(modelName)
        return await model.get(properties, params)
    }

    async remove(modelName, properties, params) {
        let model = this.getModel(modelName)
        return await model.remove(properties, params)
    }

    async scan(modelName, properties, params) {
        let model = this.getModel(modelName)
        return await model.scan(properties, params)
    }

    async update(modelName, properties, params) {
        let model = this.getModel(modelName)
        return await model.update(properties, params)
    }

    //  Low level API

    async batchGet(batch, params = {}) {
        let result
        try {
            this.log('trace', `Dynamo batchGet on "${this.name}"`, {batch}, params)
            batch.ConsistentRead = params.ConsistenRead ? true : false
            if (this.V3) {
                result = await this.client.batchGet(batch)
            } else {
                result = await this.client.batchGet(batch).promise()
            }
            let response = result.Responses
            if (params.parse && response) {
                result = []
                for (let [tableName, items] of Object.entries(response)) {
                    for (let item of items) {
                        item = this.unmarshall(item)
                        let type = item[this.typeField] || '_unknown'
                        let model = this.models[type]
                        if (model && model != this.unique) {
                            result.push(model.transformReadItem('get', item, params))
                        }
                    }
                }
            }

        } catch (err) {
            this.log('error', `BatchGet error`, {message: err.message, batch})
            throw err
        }
        return result
    }

    async batchWrite(batch, params = {}) {
        let result
        try {
            this.log('trace', `Dynamo batchWrite on "${this.name}"`, {batch}, params)
            if (this.V3) {
                result = await this.client.batchWrite(batch)
            } else {
                result = await this.client.batchWrite(batch).promise()
            }
        } catch (err) {
            this.log('error', `BatchWrite error`, {message: err.message, batch})
            throw err
        }
        return result
    }

    async deleteItem(properties, params) {
        return await this.generic.deleteItem(properties, params)
    }

    async getItem(properties, params) {
        return await this.generic.getItem(properties, params)
    }

    async putItem(properties, params) {
        return await this.generic.putItem(properties, params)
    }

    async queryItems(properties, params) {
        return await this.generic.queryItems(properties, params)
    }

    async scanItems(properties, params) {
        return await this.generic.scanItems(properties, params)
    }

    async updateItem(properties, params) {
        return await this.generic.updateItem(properties, params)
    }

    /*
        Invoke a prepared transaction
        Note: transactGet does not work on non-primary indexes
     */
    async transact(op, transaction, params = {}) {
        let result
        try {
            this.log('trace', `Dynamo "${op}" transaction on "${this.name}"`, {transaction, op}, params)
            if (op == 'write') {
                result = await this.client.transactWrite(transaction)
            } else {
                result = await this.client.transactGet(transaction)
            }
            if (!this.V3) {
                result = result.promise()
            }
            if (op == 'get') {
                if (params.parse) {
                    let items = []
                    for (let r of result.Responses) {
                        if (r.Item) {
                            let item = this.unmarshall(r.Item)
                            let type = item[this.typeField] || '_unknown'
                            let model = this.models[type]
                            if (model && model != this.unique) {
                                items.push(model.transformReadItem('get', item, params))
                            }
                        }
                    }
                    result = items
                }
            }
        } catch (err) {
            this.log('error', `Transaction error`, {message: err.message, transaction})
            throw err
        }
        return result
    }

    /*
        Convert items into a map of items by model type
     */
    groupByType(items) {
        let result = {}
        for (let [index, item] of Object.entries(items)) {
            let type = item[this.typeField] || '_unknown'
            let list = result[type] = result[type] || []
            list.push(item)
        }
        return result
    }

    log(type, message, context, params) {
        if (this.logger) {
            if (params && params.log) {
                this.logger('info', message, context)
            } else {
                this.logger(type, message, context)
            }
        }
    }

    defaultLogger(type, message, context) {
        if (type == 'trace' || type == 'data') {
            return
        }
        console.log(type, message, JSON.stringify(context, null, 4))
    }

    // Simple non-crypto UUID. See node-uuid if you require crypto UUIDs.
    uuid() {
        return 'xxxxxxxxxxxxxxxxyxxxxxxxxxyxxxxx'.replace(/[xy]/g, function(c) {
            let r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8)
            return v.toString(16)
        })
    }

    // Simple time-based, sortable unique ID.
    ulid() {
        return new ULID().toString()
    }

    initCrypto(crypto) {
        this.crypto = Object.assign(crypto || {})
        for (let [name, crypto] of Object.entries(this.crypto)) {
            crypto.secret = Crypto.createHash('sha256').update(crypto.password, 'utf8').digest()
            this.crypto[name] = crypto
            this.crypto[name].name = name
        }
    }

    encrypt(text, name = 'primary', inCode = 'utf8', outCode = 'base64') {
        if (text) {
            if (!this.crypto) {
                throw new Error('dynamo: No database secret or cipher defined')
            }
            let crypto = this.crypto[name]
            if (!crypto) {
                throw new Error(`dynamo: Database crypto not defined for ${name}`)
            }
            let iv = Crypto.randomBytes(IV_LENGTH)
            let crypt = Crypto.createCipheriv(crypto.cipher, crypto.secret, iv)
            let crypted = crypt.update(text, inCode, outCode) + crypt.final(outCode)
            let tag = (crypto.cipher.indexOf('-gcm') > 0) ? crypt.getAuthTag().toString(outCode) : ''
            text = `${crypto.name}:${tag}:${iv.toString('hex')}:${crypted}`
        }
        return text
    }

    decrypt(text, inCode = 'base64', outCode = 'utf8') {
        if (text) {
            let [name, tag, iv, data] = text.split(':')
            if (!data || !iv || !tag || !name) {
                return text
            }
            if (!this.crypto) {
                throw new Error('dynamo: No database secret or cipher defined')
            }
            let crypto = this.crypto[name]
            if (!crypto) {
                throw new Error(`dynamo: Database crypto not defined for ${name}`)
            }
            iv = Buffer.from(iv, 'hex')
            let crypt = Crypto.createDecipheriv(crypto.cipher, crypto.secret, iv)
            crypt.setAuthTag(Buffer.from(tag, inCode))
            text = crypt.update(data, inCode, outCode) + crypt.final(outCode)
        }
        return text
    }

    marshall(item) {
        let client = this.client
        if (client.V3) {
            let options = client.params.marshall
            if (Array.isArray(item)) {
                for (let i = 0; i < item.length; i++) {
                    item[i] = client.marshall(item[i], options)
                }
            } else {
                item = client.marshall(item, options)
            }
        }
        return item
    }

    unmarshall(item) {
        if (this.V3) {
            let client = this.client
            let options = client.params.unmarshall
            if (Array.isArray(item)) {
                for (let i = 0; i < item.length; i++) {
                    item[i] = client.unmarshall(item[i], options)
                }
            } else {
                item = client.unmarshall(item, options)
            }
        }
        return item
    }
}
