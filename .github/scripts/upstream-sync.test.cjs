const {test}=require('node:test');const assert=require('node:assert/strict');const {inspect}=require('./upstream-sync.cjs');
const old='a'.repeat(40),head='b'.repeat(40),pin={repository:'jonaslsaa/pi-optchat',commit:old};
function api(sha, status = 'ahead') {
  return { rest: { repos: {
    get: async () => ({ data: { default_branch: 'main' } }),
    getCommit: async () => ({ data: { sha } }),
    compareCommits: async () => ({ data: { status, commits: [{ sha, commit: { message: 'fix: upstream correction' } }] } }),
  } } };
}
test('matching upstream is healthy; changed upstream reports exact revision and comparison',async()=>{assert.equal((await inspect({github:api(old),pin})).status,'ok');const r=await inspect({github:api(head),pin});assert.equal(r.status,'findings');assert.ok(r.details.some(x=>x.includes(`${old}...${head}`)));});
test('invalid pins and unverified source responses fail closed',async()=>{await assert.rejects(inspect({github:api(head),pin:{...pin,repository:'other/repo'}}));await assert.rejects(inspect({github:api('main'),pin}));await assert.rejects(inspect({github:api(head,'behind'),pin}));});
