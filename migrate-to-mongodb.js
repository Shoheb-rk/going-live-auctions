import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MongoStore } from './mongo-store.js';

const root=dirname(fileURLToPath(import.meta.url));
const uri=process.env.MONGODB_URI;
if(!uri) throw Error('Set MONGODB_URI to your Atlas connection string before migrating.');
const sqlite=new DatabaseSync(process.env.DB_PATH||join(root,'data','auction.db'),{readOnly:true});
const mongo=await MongoStore.connect(uri,process.env.MONGODB_DATABASE||'going');
try {
  const existing=await Promise.all([mongo.users.estimatedDocumentCount(),mongo.sessions.estimatedDocumentCount(),mongo.auctions.estimatedDocumentCount()]);
  if(existing.some(Boolean)) throw Error('MongoDB target is not empty. Use a new database name to avoid duplicates or overwrites.');
  const users=sqlite.prepare('SELECT * FROM users').all();
  const sessions=sqlite.prepare('SELECT * FROM sessions').all();
  const auctions=sqlite.prepare('SELECT rowid AS created,* FROM auctions ORDER BY rowid').all();
  const bids=sqlite.prepare('SELECT * FROM bids ORDER BY seq').all();
  if(users.length) await mongo.users.insertMany(users.map(u=>({...u,created:0})));
  if(sessions.length) await mongo.sessions.insertMany(sessions.map(s=>({_id:s.token,userId:s.user_id,expires:new Date(s.expires)})));
  if(auctions.length) await mongo.auctions.insertMany(auctions.map(a=>{
    const auctionBids=bids.filter(b=>b.auction===a.id).map(({auction,...b})=>b);
    return {id:a.id,seller:a.seller,title:a.title,description:a.description,category:a.category,start:a.start,increment:a.increment,ends:a.ends,status:a.status,winner:a.winner,price:a.price,version:a.version,bidSeq:auctionBids.reduce((max,b)=>Math.max(max,b.seq),0),bids:auctionBids,created:a.created};
  }));
  console.log(`Migrated ${users.length} users, ${sessions.length} sessions, ${auctions.length} auctions and ${bids.length} bids to MongoDB.`);
} finally {
  sqlite.close();
  await mongo.disconnect();
}
