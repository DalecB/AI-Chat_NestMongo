import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection } from "mongoose";

export interface InMemoryMongo {
  mongod: MongoMemoryServer;
  connection: Connection;
  uri: string;
}

// Unit-level Mongoose 테스트용 standalone 인메모리 Mongo.
// transaction이 필요한 경우(SessionsService.deleteOwnedWithMessages)에는 사용 불가 → e2e의 ReplSet 사용.
export async function startInMemoryMongo(): Promise<InMemoryMongo> {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);

  return { mongod, connection: mongoose.connection, uri };
}

export async function stopInMemoryMongo(instance: InMemoryMongo): Promise<void> {
  await mongoose.disconnect();
  await instance.mongod.stop();
}

export async function clearAllCollections(instance: InMemoryMongo): Promise<void> {
  const collections = await instance.connection.db!.collections();
  for (const collection of collections) {
    await collection.deleteMany({});
  }
}
