import { DatabaseSync } from 'node:sqlite';
import { randomUUID, scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';

export class Store {
  constructor(path, now = Date.now) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,salt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auctions(id TEXT PRIMARY KEY,seller TEXT REFERENCES users(id),title TEXT,description TEXT,category TEXT,start INTEGER,increment INTEGER,ends INTEGER,status TEXT DEFAULT 'live',winner TEXT REFERENCES users(id),price INTEGER,version INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS bids(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,auction TEXT REFERENCES auctions(id),bidder TEXT REFERENCES users(id),amount INTEGER,created INTEGER,request TEXT,UNIQUE(bidder,request));`);
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  register(name,email,password) {
    if(typeof name !== 'string'||name.trim().length<2||name.length>60||typeof email!=='string'||!/^\S+@\S+\.\S+$/.test(email)||email.length>200||typeof password!=='string'||password.length<10||password.length>128) throw Error('Use a name, valid email, and password of 10–128 characters.');
    const id=randomUUID(),salt=randomBytes(16).toString('hex');
    try { this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id,name.trim(),email.toLowerCase(),scryptSync(password,salt,64).toString('hex'),salt); } catch { throw Error('Email already registered.'); }
    return {id,name:name.trim()};
  }
  login(email,password) {
    const u=this.db.prepare('SELECT * FROM users WHERE email=?').get(String(email).toLowerCase());
    const hash=scryptSync(String(password),u?.salt||'dummy-salt',64);
    if(!u||!timingSafeEqual(hash,Buffer.from(u.password,'hex'))) throw Error('Incorrect email or password.');
    const token=randomBytes(32).toString('hex'); this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token,u.id,this.now()+86400000);
    return token;
  }
  user(token) { return this.db.prepare('SELECT u.id,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(token||'',this.now()); }
  create(user,input) {
    const {title,description='',category='Objects',start,increment,duration}=input;
    if(typeof title!=='string'||title.trim().length<3||title.length>100||typeof description!=='string'||description.length>2000||!['Objects','Technology','Art','Collectibles'].includes(category)||!Number.isSafeInteger(start)||start<100||start>100000000||!Number.isSafeInteger(increment)||increment<100||increment>10000000||!Number.isInteger(duration)||duration<1||duration>10080) throw Error('Check listing fields. Prices are integer paise, minimum ₹1; duration is 1–10080 minutes.');
    const id=randomUUID();this.db.prepare('INSERT INTO auctions(id,seller,title,description,category,start,increment,ends,price) VALUES(?,?,?,?,?,?,?,?,?)').run(id,user.id,title.trim(),description,category,start,increment,this.now()+duration*60000,start);return id;
  }
  closeExpired() { return this.transaction(()=>this.db.prepare("UPDATE auctions SET status='closed',version=version+1 WHERE status='live' AND ends<=?").run(this.now()).changes); }
  close() { return this.closeExpired(); }
  bid(user,id,amount,request) {
    if(!Number.isSafeInteger(amount)||amount<1||amount>1000000000||typeof request!=='string'||request.length<8||request.length>100) throw Error('Invalid amount or request ID.');
    return this.transaction(()=>{
      const existing=this.db.prepare('SELECT * FROM bids WHERE bidder=? AND request=?').get(user.id,request);
      if(existing) { if(existing.auction!==id||existing.amount!==amount) throw Error('Request ID already used for a different bid.'); return existing; }
      const a=this.db.prepare('SELECT * FROM auctions WHERE id=?').get(id),now=this.now();
      if(!a||a.status!=='live'||a.ends<=now) throw Error('Auction has ended.');
      if(a.seller===user.id) throw Error('You cannot bid on your own listing.');
      const minimum=a.winner?a.price+a.increment:a.start;
      if(amount<minimum) throw Error(`Minimum bid is ₹${(minimum/100).toFixed(2)}.`);
      const bid={id:randomUUID(),auction:id,bidder:user.id,amount,created:now,request};
      this.db.prepare('INSERT INTO bids(id,auction,bidder,amount,created,request) VALUES(?,?,?,?,?,?)').run(bid.id,id,user.id,amount,now,request);
      this.db.prepare('UPDATE auctions SET price=?,winner=?,ends=?,version=version+1 WHERE id=?').run(amount,user.id,Math.max(a.ends,now+15000),id);
      return bid;
    });
  }
  snapshot() {
    this.closeExpired();
    return {serverTime:this.now(),auctions:this.db.prepare('SELECT a.*,u.name sellerName,w.name winnerName FROM auctions a JOIN users u ON u.id=a.seller LEFT JOIN users w ON w.id=a.winner ORDER BY a.rowid DESC').all(),bids:this.db.prepare('SELECT b.*,u.name bidderName FROM bids b JOIN users u ON u.id=b.bidder ORDER BY seq DESC').all()};
  }
  logout(token) { this.db.prepare('DELETE FROM sessions WHERE token=?').run(token||''); }
  disconnect() { this.db.close(); }
}
