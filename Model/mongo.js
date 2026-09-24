import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decimal128, MongoClient, ObjectId } from 'mongodb';

export const DATABASE_NAME = 'SGSP';

const defaultDataFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'database', 'sgsp.local.json');

let databaseInstance;
let loadPromise;
let readyPromise;
let isReady = false;
let mongoClient;
let mongoDatabase;
let mongoConnectPromise;

function getMongoUri() {
  return String(process.env.MONGODB_URI || '').trim();
}

function logMongoConnectionError(error) {
  const details = error?.name || error?.codeName || error?.message || 'Error desconocido';
  if (error?.name === 'MongoServerError' || error?.codeName === 'AuthenticationFailed') {
    console.error(`[MongoDB] Falló la autenticación contra MongoDB Atlas: ${details}`);
    return;
  }
  if (error?.name === 'MongoServerSelectionError' || error?.name === 'MongoNetworkError') {
    console.error(`[MongoDB] No se pudo alcanzar MongoDB Atlas por red: ${details}`);
    return;
  }
  console.error(`[MongoDB] Falló la conexión: ${details}`);
}

async function loadMongoDatabase(uri) {
  if (mongoDatabase) return mongoDatabase;
  if (!mongoConnectPromise) {
    console.log('[MongoDB] Abriendo conexión reutilizable con MongoDB Atlas.');
    mongoConnectPromise = (async () => {
      const client = new MongoClient(uri, {
        maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 10),
        serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000)
      });
      try {
        await client.connect();
        await client.db(DATABASE_NAME).command({ ping: 1 });
        mongoClient = client;
        mongoDatabase = client.db(DATABASE_NAME);
        console.log(`[MongoDB] Conexión lista. Base de datos: ${DATABASE_NAME}.`);
        return mongoDatabase;
      } catch (error) {
        await client.close().catch(() => {});
        logMongoConnectionError(error);
        throw error;
      }
    })().catch((error) => {
      mongoConnectPromise = undefined;
      mongoClient = undefined;
      mongoDatabase = undefined;
      throw error;
    });
  }
  return mongoConnectPromise;
}

function getDataFilePath() {
  return process.env.SGSP_LOCAL_DB_PATH || defaultDataFile;
}

function isPlainObject(value) {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isOperatorObject(value) {
  return isPlainObject(value) && Object.keys(value).some((key) => key.startsWith('$'));
}

function serializeValue(value) {
  if (value instanceof Date) return { __type: 'Date', value: value.toISOString() };
  if (value instanceof ObjectId) return { __type: 'ObjectId', value: value.toHexString() };
  if (value?._bsontype === 'Decimal128') return { __type: 'Decimal128', value: value.toString() };
  if (Array.isArray(value)) return value.map((item) => serializeValue(item));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeValue(item)]));
  }
  return value;
}

function deserializeValue(value) {
  if (Array.isArray(value)) return value.map((item) => deserializeValue(item));
  if (isPlainObject(value) && value.__type === 'Date') return new Date(value.value);
  if (isPlainObject(value) && value.__type === 'ObjectId') return new ObjectId(value.value);
  if (isPlainObject(value) && value.__type === 'Decimal128') return Decimal128.fromString(value.value);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deserializeValue(item)]));
  }
  return value;
}

function cloneValue(value) {
  return deserializeValue(serializeValue(value));
}

function getValueByPath(document, path) {
  return String(path).split('.').reduce((current, segment) => current?.[segment], document);
}

function setValueByPath(document, path, value) {
  const segments = String(path).split('.');
  let current = document;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!isPlainObject(current[segment])) current[segment] = {};
    current = current[segment];
  }
  current[segments.at(-1)] = value;
}

function normalizeComparable(value) {
  if (value instanceof Date) return value.getTime();
  if (value instanceof ObjectId) return value.toHexString();
  if (value?._bsontype === 'Decimal128') return Number(value.toString());
  return value;
}

function valuesEqual(left, right) {
  if (left instanceof ObjectId && right instanceof ObjectId) return left.equals(right);
  if (left?._bsontype === 'Decimal128' || right?._bsontype === 'Decimal128') {
    return Number(normalizeComparable(left)) === Number(normalizeComparable(right));
  }
  return normalizeComparable(left) === normalizeComparable(right);
}

function compareValues(left, right) {
  const normalizedLeft = normalizeComparable(left);
  const normalizedRight = normalizeComparable(right);
  if (normalizedLeft === normalizedRight) return 0;
  if (normalizedLeft === undefined) return 1;
  if (normalizedRight === undefined) return -1;
  return normalizedLeft > normalizedRight ? 1 : -1;
}

function matchCondition(fieldValue, condition) {
  if (!isOperatorObject(condition)) return valuesEqual(fieldValue, condition);

  return Object.entries(condition).every(([operator, operand]) => {
    if (operator === '$ne') return !valuesEqual(fieldValue, operand);
    if (operator === '$in') return Array.isArray(operand) && operand.some((item) => valuesEqual(fieldValue, item));
    if (operator === '$nin') return Array.isArray(operand) && operand.every((item) => !valuesEqual(fieldValue, item));
    if (operator === '$gt') return compareValues(fieldValue, operand) > 0;
    if (operator === '$gte') return compareValues(fieldValue, operand) >= 0;
    if (operator === '$lt') return compareValues(fieldValue, operand) < 0;
    if (operator === '$lte') return compareValues(fieldValue, operand) <= 0;
    return false;
  });
}

function matchesQuery(document, query = {}) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === '$or') return Array.isArray(condition) && condition.some((item) => matchesQuery(document, item));
    return matchCondition(getValueByPath(document, key), condition);
  });
}

function sortDocuments(documents, sortSpec = {}) {
  const sortEntries = Object.entries(sortSpec);
  if (!sortEntries.length) return documents;
  return [...documents].sort((left, right) => {
    for (const [path, direction] of sortEntries) {
      const comparison = compareValues(getValueByPath(left, path), getValueByPath(right, path));
      if (comparison !== 0) return direction >= 0 ? comparison : -comparison;
    }
    return 0;
  });
}

function extractInsertDocument(filter = {}) {
  const document = {};
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith('$')) continue;
    if (isOperatorObject(value)) continue;
    document[key] = cloneValue(value);
  }
  return document;
}

class LocalCursor {
  constructor(documents) {
    this.documents = [...documents];
    this.offset = 0;
  }

  sort(specification) {
    this.documents = sortDocuments(this.documents, specification);
    return this;
  }

  limit(size) {
    this.documents = this.documents.slice(0, size);
    return this;
  }

  async toArray() {
    return this.documents.map((document) => cloneValue(document));
  }

  async next() {
    if (this.offset >= this.documents.length) return null;
    const value = cloneValue(this.documents[this.offset]);
    this.offset += 1;
    return value;
  }
}

class LocalCollection {
  constructor(database, name) {
    this.database = database;
    this.name = name;
  }

  get documents() {
    return this.database.ensureCollection(this.name);
  }

  async findOne(filter = {}, options = {}) {
    const cursor = new LocalCursor(this.documents.filter((document) => matchesQuery(document, filter)));
    if (options.sort) cursor.sort(options.sort);
    return cursor.next();
  }

  find(filter = {}) {
    return new LocalCursor(this.documents.filter((document) => matchesQuery(document, filter)));
  }

  async countDocuments(filter = {}) {
    return this.documents.filter((document) => matchesQuery(document, filter)).length;
  }

  async insertOne(document) {
    const stored = cloneValue(document);
    if (!stored._id) stored._id = new ObjectId();
    this.assertUnique(stored);
    this.documents.push(stored);
    await this.database.persist();
    return { insertedId: stored._id };
  }

  async insertMany(documents) {
    const stored = documents.map((document) => {
      const item = cloneValue(document);
      if (!item._id) item._id = new ObjectId();
      this.assertUnique(item);
      return item;
    });
    this.documents.push(...stored);
    await this.database.persist();
    return { insertedCount: stored.length, insertedIds: stored.map((item) => item._id) };
  }

  async updateOne(filter, update, options = {}) {
    const index = this.documents.findIndex((document) => matchesQuery(document, filter));
    if (index === -1) {
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedId: null };
      const inserted = { ...extractInsertDocument(filter) };
      if (update.$setOnInsert) Object.assign(inserted, cloneValue(update.$setOnInsert));
      if (update.$set) Object.assign(inserted, cloneValue(update.$set));
      if (!inserted._id) inserted._id = new ObjectId();
      this.assertUnique(inserted);
      this.documents.push(inserted);
      await this.database.persist();
      return { matchedCount: 0, modifiedCount: 0, upsertedId: inserted._id };
    }

    const document = this.documents[index];
    if (update.$set) {
      for (const [path, value] of Object.entries(update.$set)) setValueByPath(document, path, cloneValue(value));
    }
    this.assertUnique(document, document._id);
    await this.database.persist();
    return { matchedCount: 1, modifiedCount: 1, upsertedId: null };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    const index = this.documents.findIndex((document) => matchesQuery(document, filter));
    if (index === -1) {
      if (!options.upsert) return null;
      const inserted = { ...extractInsertDocument(filter) };
      if (update.$setOnInsert) Object.assign(inserted, cloneValue(update.$setOnInsert));
      if (update.$set) Object.assign(inserted, cloneValue(update.$set));
      if (!inserted._id) inserted._id = new ObjectId();
      this.assertUnique(inserted);
      this.documents.push(inserted);
      await this.database.persist();
      return cloneValue(inserted);
    }
    const before = cloneValue(this.documents[index]);
    if (update.$set) {
      for (const [path, value] of Object.entries(update.$set)) setValueByPath(this.documents[index], path, cloneValue(value));
    }
    this.assertUnique(this.documents[index], this.documents[index]._id);
    await this.database.persist();
    return options.returnDocument === 'before' ? before : cloneValue(this.documents[index]);
  }

  async deleteOne(filter) {
    const index = this.documents.findIndex((document) => matchesQuery(document, filter));
    if (index === -1) return { deletedCount: 0 };
    this.documents.splice(index, 1);
    await this.database.persist();
    return { deletedCount: 1 };
  }

  aggregate(pipeline = []) {
    let documents = this.documents.map((document) => cloneValue(document));
    for (const stage of pipeline) {
      if (stage.$match) {
        documents = documents.filter((document) => matchesQuery(document, stage.$match));
        continue;
      }
      if (stage.$lookup) {
        const foreignDocuments = this.database.ensureCollection(stage.$lookup.from);
        documents = documents.map((document) => {
          const localValue = getValueByPath(document, stage.$lookup.localField);
          const joined = foreignDocuments
            .filter((candidate) => valuesEqual(getValueByPath(candidate, stage.$lookup.foreignField), localValue))
            .map((candidate) => cloneValue(candidate));
          return { ...document, [stage.$lookup.as]: joined };
        });
        continue;
      }
      if (stage.$unwind) {
        const descriptor = typeof stage.$unwind === 'string' ? { path: stage.$unwind } : stage.$unwind;
        const path = descriptor.path.replace(/^\$/, '');
        const expanded = [];
        for (const document of documents) {
          const value = getValueByPath(document, path);
          if (Array.isArray(value) && value.length) {
            for (const item of value) {
              const clone = cloneValue(document);
              setValueByPath(clone, path, item);
              expanded.push(clone);
            }
            continue;
          }
          if (descriptor.preserveNullAndEmptyArrays) {
            const clone = cloneValue(document);
            if (Array.isArray(value)) setValueByPath(clone, path, null);
            expanded.push(clone);
          }
        }
        documents = expanded;
        continue;
      }
      if (stage.$project) {
        documents = documents.map((document) => {
          const projection = {};
          for (const [field, instruction] of Object.entries(stage.$project)) {
            if (instruction === 1) {
              projection[field] = getValueByPath(document, field);
              continue;
            }
            if (typeof instruction === 'string' && instruction.startsWith('$')) {
              projection[field] = getValueByPath(document, instruction.slice(1));
            }
          }
          return projection;
        });
        continue;
      }
      if (stage.$sort) {
        documents = sortDocuments(documents, stage.$sort);
        continue;
      }
      if (stage.$limit) {
        documents = documents.slice(0, stage.$limit);
      }
    }
    return new LocalCursor(documents);
  }

  listIndexes() {
    return new LocalCursor([]);
  }

  assertUnique(document, currentId = null) {
    const duplicate = this.documents.find((candidate) => {
      if (currentId && candidate._id instanceof ObjectId && candidate._id.equals(currentId)) return false;
      if (this.name === 'usuarios') return candidate.username === document.username;
      if (this.name === 'colaboradores' && document.rut) return candidate.rut === document.rut;
      if (this.name === 'pausasSala' && document.fin === null) {
        return valuesEqual(candidate.turnoId, document.turnoId) && valuesEqual(candidate.colaboradorId, document.colaboradorId) && candidate.fin === null;
      }
      return false;
    });
    if (!duplicate) return;
    const error = new Error('Clave duplicada.');
    error.code = 11000;
    throw error;
  }
}

class LocalDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { _meta: { name: DATABASE_NAME, storage: 'local-json', createdAt: new Date() }, collections: {} };
    this.writePromise = Promise.resolve();
  }

  async load() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.data = deserializeValue(JSON.parse(raw));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persist();
    }
    if (!this.data.collections) this.data.collections = {};
    return this;
  }

  ensureCollection(name) {
    if (!this.data.collections[name]) this.data.collections[name] = [];
    return this.data.collections[name];
  }

  collection(name) {
    return new LocalCollection(this, name);
  }

  async command(command) {
    if (command?.ping === 1) return { ok: 1 };
    return { ok: 0 };
  }

  async persist() {
    const operation = this.writePromise.catch(() => {}).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempFile = `${this.filePath}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
      await writeFile(tempFile, JSON.stringify(serializeValue(this.data), null, 2), 'utf8');
      await rename(tempFile, this.filePath);
    });
    this.writePromise = operation;
    return operation;
  }
}

async function loadDatabase() {
  const mongoUri = getMongoUri();
  if (mongoUri) return loadMongoDatabase(mongoUri);
  if (databaseInstance) return databaseInstance;
  if (!loadPromise) {
    databaseInstance = new LocalDatabase(getDataFilePath());
    loadPromise = databaseInstance.load().catch((error) => {
      databaseInstance = undefined;
      loadPromise = undefined;
      throw error;
    });
  }
  await loadPromise;
  return databaseInstance;
}

export async function initializeDatabase() {
  if (!readyPromise) {
    readyPromise = loadDatabase().then(async (database) => {
      await ensureCollaboratorCollection(database);
      isReady = true;
      return database;
    }).catch((error) => {
      readyPromise = undefined;
      isReady = false;
      throw error;
    });
  }
  return readyPromise;
}

export async function ensureCollaboratorCollection(database) {
  database ||= await loadDatabase();
  if (typeof database.listCollections !== 'function') {
    database.ensureCollection?.('colaboradores');
    return;
  }
  const collections = await database.listCollections({ name: 'colaboradores' }).toArray();
  if (!collections.length) await database.createCollection('colaboradores');
}

export async function seedEmptyDatabase(database) {
  database ||= await loadDatabase();
  if (await database.collection('colaboradores').countDocuments({}) > 0) return;
  const { seedLocalDatabase } = await import('./localSeed.js');
  await seedLocalDatabase();
}

export async function getDatabase() {
  return loadDatabase();
}

export async function pingDatabase() {
  if (!isReady) throw new Error('La base local aún no fue inicializada.');
  const database = await initializeDatabase();
  await database.command({ ping: 1 });
  return true;
}

export async function closeMongo() {
  if (mongoClient) await mongoClient.close().catch((error) => console.error(`[MongoDB] Error al cerrar la conexión: ${error.message}`));
  mongoClient = undefined;
  mongoDatabase = undefined;
  mongoConnectPromise = undefined;
  databaseInstance = undefined;
  loadPromise = undefined;
  readyPromise = undefined;
  isReady = false;
}
