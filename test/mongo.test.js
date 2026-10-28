import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MongoStore} from '../mongo-store.js';

const uri=process.env.MONGODB_TEST_URI;
test('MongoDB Atlas: concurrent bids, retry idempotency and durable result', {skip:!uri}, async()=>{
  const database=`going_test_${randomUUID().replaceAll('-','')}`;
  const store=await MongoStore.connect(uri,database,Date.now);
  try {
    const seller=await store.register('Seller','seller@example.com','password123');
    const alice=await store.register('Alice','alice@example.com','password123');
    const bob=await store.register('Bob','bob@example.com','password123');
    const id=await store.create(seller,{title:'Studio clock',description:'Excellent condition',category:'Objects',start:10000,increment:1000,duration:1});
    const attempts=await Promise.allSettled([
      store.bid(alice,id,10000,'request-0001'),
      store.bid(bob,id,10000,'request-0002')
    ]);
    assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(attempts.filter(x=>x.status==='rejected').length,1);
    const accepted=attempts.find(x=>x.status==='fulfilled').value;
    const acceptedUser=accepted.bidder===alice.id?alice:bob;
    assert.equal((await store.bid(acceptedUser,id,10000,accepted.request)).id,accepted.id);
    const snapshot=await store.snapshot();
    assert.equal(snapshot.bids.length,1);
    assert.equal(snapshot.auctions[0].price,10000);
    assert.equal(snapshot.auctions[0].winner,accepted.bidder);
  } finally {
    await store.db.dropDatabase();
    await store.disconnect();
  }
});
