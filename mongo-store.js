import { MongoClient, ServerApiVersion } from 'mongodb';
import { randomUUID, scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';

function validateAccount(name,email,password) {
  if(typeof name !== 'string'||name.trim().length<2||name.length>60||typeof email!=='string'||!/^\S+@\S+\.\S+$/.test(email)||email.length>200||typeof password!=='string'||password.length<10||password.length>128) throw Error('Use a name, valid email, and password of 10–128 characters.');
}
function validateListing(input) {
  const {title,description='',category='Objects',start,increment,duration}=input;
  if(typeof title!=='string'||title.trim().length<3||title.length>100||typeof description!=='string'||description.length>2000||!['Objects','Technology','Art','Collectibles'].includes(category)||!Number.isSafeInteger(start)||start<100||start>100000000||!Number.isSafeInteger(increment)||increment<100||increment>10000000||!Number.isInteger(duration)||duration<1||duration>10080) throw Error('Check listing fields. Prices are integer paise, minimum ₹1; duration is 1–10080 minutes.');
  return {title:title.trim(),description,category,start,increment,duration};
}
function validateBid(amount,request) {
  if(!Number.isSafeInteger(amount)||amount<1||amount>1000000000||typeof request!=='string'||request.length<8||request.length>100) throw Error('Invalid amount or request ID.');
}

export class MongoStore {
  static async connect(uri, databaseName='going', now=Date.now) {
    if(!uri) throw Error('MONGODB_URI is required for MongoDB storage.');
    const client=new MongoClient(uri,{serverApi:{version:ServerApiVersion.v1,strict:true,deprecationErrors:true},serverSelectionTimeoutMS:10000});
    await client.connect();
    const store=new MongoStore(client,client.db(databaseName),now);
    await store.init();
    return store;
  }
  constructor(client,db,now=Date.now) {
    this.client=client;this.db=db;this.now=now;
    this.users=db.collection('users');this.sessions=db.collection('sessions');this.auctions=db.collection('auctions');
  }
  async init() {
    await this.db.command({ping:1});
    await Promise.all([
      this.users.createIndex({email:1},{unique:true,name:'unique_email'}),
      this.sessions.createIndex({expires:1},{expireAfterSeconds:0,name:'expire_sessions'}),
      this.auctions.createIndex({id:1},{unique:true,name:'unique_auction_id'}),
      this.auctions.createIndex({status:1,ends:1},{name:'close_due_auctions'}),
      this.auctions.createIndex({'bids.request':1},{name:'idempotent_bid_lookup'})
    ]);
  }
  async register(name,email,password) {
    validateAccount(name,email,password);
    const id=randomUUID(),salt=randomBytes(16).toString('hex');
    try { await this.users.insertOne({id,name:name.trim(),email:email.toLowerCase(),password:scryptSync(password,salt,64).toString('hex'),salt,created:this.now()}); }
    catch(e) { if(e?.code===11000) throw Error('Email already registered.'); throw e; }
    return {id,name:name.trim()};
  }
  async login(email,password) {
    const u=await this.users.findOne({email:String(email).toLowerCase()});
    const hash=scryptSync(String(password),u?.salt||'dummy-salt',64);
    if(!u||!timingSafeEqual(hash,Buffer.from(u.password,'hex'))) throw Error('Incorrect email or password.');
    const token=randomBytes(32).toString('hex');
    await this.sessions.insertOne({_id:token,userId:u.id,expires:new Date(this.now()+86400000)});
    return token;
  }
  async user(token) {
    if(!token) return undefined;
    const session=await this.sessions.findOne({_id:token,expires:{$gt:new Date(this.now())}});
    if(!session) return undefined;
    const user=await this.users.findOne({id:session.userId},{projection:{_id:0,id:1,name:1}});
    return user||undefined;
  }
  async logout(token) { if(token) await this.sessions.deleteOne({_id:token}); }
  async create(user,input) {
    const listing=validateListing(input),id=randomUUID(),created=this.now();
    await this.auctions.insertOne({id,seller:user.id,title:listing.title,description:listing.description,category:listing.category,start:listing.start,increment:listing.increment,ends:created+listing.duration*60000,status:'live',winner:null,price:listing.start,version:1,bidSeq:0,bids:[],created});
    return id;
  }
  async closeExpired() {
    const result=await this.auctions.updateMany({status:'live',ends:{$lte:this.now()}},{$set:{status:'closed'},$inc:{version:1}});
    return result.modifiedCount;
  }
  async bid(user,id,amount,request) {
    validateBid(amount,request);
    const prior=await this.auctions.findOne({'bids':{$elemMatch:{bidder:user.id,request}}},{projection:{id:1,bids:{$elemMatch:{bidder:user.id,request}}}});
    if(prior) {
      const existing=prior.bids[0];
      if(prior.id!==id||existing.amount!==amount) throw Error('Request ID already used for a different bid.');
      return {...existing,auction:prior.id};
    }
    const time=this.now(),bidId=randomUUID();
    const updated=await this.auctions.findOneAndUpdate(
      {id,status:'live',ends:{$gt:time},seller:{$ne:user.id},bids:{$not:{$elemMatch:{bidder:user.id,request}}},$or:[{winner:null,start:{$lte:amount}},{$expr:{$and:[{$ne:['$winner',null]},{$lte:[{$add:['$price','$increment']},amount]}]}}]},
      [{$set:{price:amount,winner:user.id,ends:{$cond:[{$lt:['$ends',time+15000]},time+15000,'$ends']},version:{$add:['$version',1]},bidSeq:{$add:['$bidSeq',1]},bids:{$concatArrays:['$bids',[{id:bidId,bidder:user.id,amount,created:time,request,seq:{$add:['$bidSeq',1]}}]]}}}],
      {returnDocument:'after',includeResultMetadata:false,projection:{id:1,bids:1}}
    );
    if(updated) return {...updated.bids.at(-1),auction:id};
    const retry=await this.auctions.findOne({'bids':{$elemMatch:{bidder:user.id,request}}},{projection:{id:1,bids:{$elemMatch:{bidder:user.id,request}}}});
    if(retry) {
      const existing=retry.bids[0];
      if(retry.id!==id||existing.amount!==amount) throw Error('Request ID already used for a different bid.');
      return {...existing,auction:retry.id};
    }
    const auction=await this.auctions.findOne({id});
    if(!auction||auction.status!=='live'||auction.ends<=time) throw Error('Auction has ended.');
    if(auction.seller===user.id) throw Error('You cannot bid on your own listing.');
    const minimum=auction.winner?auction.price+auction.increment:auction.start;
    throw Error(`Minimum bid is ₹${(minimum/100).toFixed(2)}.`);
  }
  async snapshot() {
    await this.closeExpired();
    const docs=await this.auctions.find({}).sort({created:-1}).toArray();
    const ids=[...new Set(docs.flatMap(a=>[a.seller,a.winner,...a.bids.map(b=>b.bidder)]).filter(Boolean))];
    const users=ids.length?await this.users.find({id:{$in:ids}},{projection:{_id:0,id:1,name:1}}).toArray():[];
    const names=new Map(users.map(u=>[u.id,u.name]));
    const auctions=docs.map(({_id,bids,bidSeq,created,...a})=>({...a,sellerName:names.get(a.seller)||'Unknown',winnerName:a.winner?names.get(a.winner)||'Unknown':null}));
    const bids=docs.flatMap(a=>a.bids.map(b=>({...b,auction:a.id,bidderName:names.get(b.bidder)||'Unknown'}))).sort((a,b)=>b.created-a.created||b.seq-a.seq);
    return {serverTime:this.now(),auctions,bids};
  }
  async disconnect() { await this.client.close(); }
}
