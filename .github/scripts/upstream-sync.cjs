async function inspect({ github, pin }) {
  if (pin.repository !== 'jonaslsaa/pi-optchat' || !/^[a-f0-9]{40}$/.test(pin.commit)) throw Error('Invalid OptChat upstream pin');
  const source = { owner: 'jonaslsaa', repo: 'pi-optchat' };
  const { data: repo } = await github.rest.repos.get(source);
  const { data: head } = await github.rest.repos.getCommit({ ...source, ref: repo.default_branch });
  if (!/^[a-f0-9]{40}$/.test(head.sha)) throw Error('Invalid upstream head');
  if (head.sha === pin.commit) return { status: 'ok', summary: 'OptChatの参照元は最新です。', details: [] };
  const { data: diff } = await github.rest.repos.compareCommits({ ...source, base: pin.commit, head: head.sha });
  if (!['ahead', 'diverged'].includes(diff.status)) throw Error('Upstream pin is not an older or diverged revision');
  return { status: 'findings', summary: '元OptChatに未反映の更新があります。', details: [
    `参照済み: ${pin.commit}`, `最新: ${head.sha}`, `比較: https://github.com/${pin.repository}/compare/${pin.commit}...${head.sha}`,
    ...diff.commits.slice(0, 50).map(c => `- ${c.sha.slice(0, 7)} ${c.commit.message.split('\n')[0]}`),
    '変更をレビューして必要な処理を移植し、検証後に .github/upstream.json のcommitを更新してください。自動的なソース上書きは行いません。',
  ] };
}
module.exports = { inspect };
