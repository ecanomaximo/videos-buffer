#!/usr/bin/env node
// Despachante na nuvem: roda de hora em hora no GitHub Actions do repositório de vídeos
// (workflow despachar.yml), com o PC desligado. Não tem dependências: só Node 22.
//
// A cada execução:
//   1. Lê grade.json do repositório (montada no domingo por publicar/semana.mjs).
//   2. Agenda no Buffer os posts das próximas JANELA_H horas que ainda não foram criados.
//      O Buffer Free aceita só 10 posts na fila por canal, por isso a semana não vai toda
//      de uma vez: entra aos poucos, sempre com no máximo MAX_FILA por canal.
//   3. Confere o status dos posts já agendados (sent / error).
//   4. Grava a grade de volta (API do GitHub, com nova tentativa se houver conflito).
//   5. Instagram direto (sem Buffer), para os canais com token em INSTAGRAM_CONFIG: a API da
//      Meta não agenda, então o despachante prepara o vídeo até ADIANTO_MIN antes, espera o
//      horário do post e publica. A grade é gravada a cada passo, para nunca postar duas vezes.
//   6. Apaga da release os vídeos cujos posts já saíram todos.
//
// Variáveis (secrets do repositório, passadas pelo workflow):
//   BUFFER_CONFIG  JSON: { "chaves": { "tiktok": "...", "instagram": "..." },
//                          "canais": { "tiktok": { "<canal>": "<id>" }, "instagram": { ... } } }
//   INSTAGRAM_CONFIG (opcional) JSON: { "<canal>": { "token": "...", "ig_id": "...", "api": "facebook" | "instagram" } }
//                  Canal presente aqui publica o Instagram direto pela API da Meta.
//                  api "facebook" = token de usuário do sistema (login unificado, graph.facebook.com);
//                  "instagram" ou ausente = token do login do Instagram (graph.instagram.com).
//   GITHUB_TOKEN, GITHUB_REPOSITORY (o Actions já fornece)
//   GRADE_PATH (opcional, padrão grade.json), RELEASE_TAG (padrão videos)
//   DRY_RUN=1 só mostra o que faria.

const JANELA_H = 48;          // agenda com até 48 h de antecedência
const MAX_FILA = 8;           // máximo de posts nossos na fila de cada canal (Free = 10)
const ATRASO_MAX_H = 3;       // post atrasado até 3 h ainda sai na hora; depois disso é "perdido"
const ADIANTO_MIN = 50;       // Instagram direto: começa a preparar até 50 min antes do horário
const ESPERA_CONTAINER_MIN = 10; // tempo máximo para a Meta baixar e processar o vídeo
const FINAIS = new Set(['sent', 'perdido']);

const env = process.env;
const DRY = env.DRY_RUN === '1';
const REPO = env.GITHUB_REPOSITORY;
const GRADE = env.GRADE_PATH || 'grade.json';
const TAG = env.RELEASE_TAG || 'videos';
const cfg = JSON.parse(env.BUFFER_CONFIG || '{}');
const ig = JSON.parse(env.INSTAGRAM_CONFIG || '{}');
const IG_VERSAO = 'v27.0';
const igApi = (canal) => `https://graph.${ig[canal].api === 'facebook' ? 'facebook' : 'instagram'}.com/${IG_VERSAO}`;
// Instagram direto: canal com token da Meta. Post que já está no Buffer (tem post_id) segue por lá.
const ehDireto = (p) => p.rede === 'instagram' && Boolean(ig[p.canal]?.token) && !p.post_id;
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

const log = (m) => console.log(m);
function falhar(m) { throw new Error(m); }

// ------------------------------------------------------------------ GitHub REST

async function gh(metodo, caminho, corpo) {
  const r = await fetch(`https://api.github.com${caminho}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'despachar-videos',
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  return { status: r.status, json: txt ? JSON.parse(txt) : null };
}

async function lerGrade() {
  const r = await gh('GET', `/repos/${REPO}/contents/${GRADE}`);
  if (r.status === 404) return { grade: { posts: [] }, sha: null };
  if (r.status !== 200) falhar(`GitHub: não li ${GRADE} (HTTP ${r.status}).`);
  return { grade: JSON.parse(Buffer.from(r.json.content, 'base64').toString('utf8')), sha: r.json.sha };
}

// Grava só as mudanças deste ciclo por cima da versão mais nova (alguém pode ter
// acrescentado posts no meio do caminho). Tenta de novo em caso de conflito.
async function gravarGrade(mudancas, msg) {
  if (!Object.keys(mudancas).length) return log('Grade sem mudanças.');
  if (DRY) return log(`DRY_RUN: gravaria ${Object.keys(mudancas).length} mudança(s) na grade.`);
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const { grade, sha } = await lerGrade();
    for (const p of grade.posts) if (mudancas[p.id]) Object.assign(p, mudancas[p.id]);
    const conteudo = Buffer.from(JSON.stringify(grade, null, 2) + '\n').toString('base64');
    const r = await gh('PUT', `/repos/${REPO}/contents/${GRADE}`, { message: msg, content: conteudo, ...(sha && { sha }) });
    if (r.status === 200 || r.status === 201) return log('Grade gravada.');
    if (r.status !== 409 && r.status !== 422) falhar(`GitHub: não gravei a grade (HTTP ${r.status}: ${r.json?.message}).`);
    await new Promise((ok) => setTimeout(ok, 2000 * (tentativa + 1)));
  }
  falhar('GitHub: conflito ao gravar a grade 5 vezes seguidas.');
}

// ------------------------------------------------------------------ Buffer GraphQL

async function gql(rede, query, variables = {}) {
  const chave = cfg.chaves?.[rede];
  if (!chave) falhar(`BUFFER_CONFIG sem chave de ${rede}.`);
  const r = await fetch('https://api.buffer.com', {
    method: 'POST',
    headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors?.length) falhar(`Buffer HTTP ${r.status}: ${j.errors?.map((e) => e.message).join('; ') ?? JSON.stringify(j)}`);
  return j.data;
}

async function criarPost(p, agora) {
  const channelId = cfg.canais?.[p.rede]?.[p.canal];
  if (!channelId) falhar(`BUFFER_CONFIG sem id do canal ${p.rede}/${p.canal}.`);
  const input = {
    channelId,
    text: p.legenda,
    schedulingType: 'automatic',
    needsApproval: false,
    mode: agora ? 'shareNow' : 'customScheduled',
    ...(!agora && { dueAt: new Date(p.quando).toISOString() }),
    assets: [{ video: { url: p.url, metadata: { thumbnailOffset: 1000 } } }],
    ...(p.rede === 'instagram' && { metadata: { instagram: { type: 'reel', shouldShareToFeed: true } } }),
  };
  const { createPost: res } = await gql(
    p.rede,
    `mutation($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id status dueAt } }
        ... on MutationError { message }
      }
    }`,
    { input },
  );
  if (!res?.post) falhar(`Buffer recusou: ${res?.message ?? JSON.stringify(res)}`);
  return res.post;
}

async function statusPost(rede, id) {
  const { post } = await gql(rede, 'query($id: PostId!) { post(input: { id: $id }) { id status dueAt sentAt externalLink error { message } } }', { id });
  return post;
}

// ------------------------------------------------------------------ Instagram direto (API da Meta)

async function graph(canal, caminho, metodo = 'GET', params = {}) {
  const corpo = new URLSearchParams({ ...params, access_token: ig[canal].token });
  const url = new URL(`${igApi(canal)}${caminho}`);
  let r;
  if (metodo === 'GET') { url.search = corpo.toString(); r = await fetch(url); } else r = await fetch(url, { method: metodo, body: corpo });
  const j = await r.json().catch(() => ({}));
  if (j.error) falhar(`Instagram ${caminho}: ${j.error.message} (code ${j.error.code})`);
  return j;
}

// Prepara (se preciso), espera o horário e publica um Reel.
// O container guardado na grade evita repetir: se uma execução anterior já publicou e caiu
// antes de gravar, o container aparece como PUBLISHED e o post só é marcado como enviado.
async function publicarDireto(p, salvar) {
  const conta = ig[p.canal];
  let container = p.container_id;
  if (!container) {
    const r = await graph(p.canal, `/${conta.ig_id}/media`, 'POST', {
      media_type: 'REELS', video_url: p.url, caption: p.legenda, share_to_feed: 'true', thumb_offset: '1000',
    });
    container = r.id;
    await salvar({ container_id: container, status: 'preparando', criado_em: new Date().toISOString() });
    log(`${p.id}: container ${container} criado`);
  }
  const limite = Date.now() + ESPERA_CONTAINER_MIN * 60e3;
  for (;;) {
    const { status_code: s, status } = await graph(p.canal, `/${container}`, 'GET', { fields: 'status_code,status' });
    if (s === 'PUBLISHED') {
      await salvar({ status: 'sent', publicado_em: new Date().toISOString() });
      return log(`${p.id}: já tinha sido publicado (container PUBLISHED)`);
    }
    if (s === 'FINISHED') break;
    if (s === 'ERROR' || s === 'EXPIRED') {
      await salvar({ container_id: null, status: null });
      falhar(`a Meta recusou o vídeo (${status ?? s}); tento de novo na próxima execução`);
    }
    if (Date.now() > limite) falhar(`container ${container} ainda processando depois de ${ESPERA_CONTAINER_MIN} min`);
    await esperar(20e3);
  }
  const falta = new Date(p.quando).getTime() - Date.now();
  if (falta > 0) { log(`${p.id}: pronto; espero ${Math.round(falta / 60e3)} min até ${p.quando}`); await esperar(falta); }
  const { id: midia } = await graph(p.canal, `/${conta.ig_id}/media_publish`, 'POST', { creation_id: container });
  // grava antes de buscar o link: se o link falhar, o post não volta para a fila
  await salvar({ post_id: midia, status: 'sent', publicado_em: new Date().toISOString() });
  const { permalink } = await graph(p.canal, `/${midia}`, 'GET', { fields: 'permalink' }).catch(() => ({}));
  if (permalink) await salvar({ link: permalink });
  log(`${p.id}: publicado ${permalink ?? midia}`);
}

// ------------------------------------------------------------------ ciclo

async function main() {
  if (!REPO || !env.GITHUB_TOKEN) falhar('Faltam GITHUB_REPOSITORY e GITHUB_TOKEN.');
  const { grade } = await lerGrade();
  const posts = grade.posts ?? [];
  const agora = Date.now();
  const mudancas = {};
  const mudar = (p, m) => { Object.assign(p, m); mudancas[p.id] = { ...mudancas[p.id], ...m }; };
  let erros = 0;

  // 1. status dos posts já criados
  for (const p of posts) {
    if (!p.post_id || FINAIS.has(p.status) || p.container_id) continue;
    try {
      const s = await statusPost(p.rede, p.post_id);
      if (!s) { mudar(p, { status: 'error', erro: 'post não existe mais no Buffer' }); continue; }
      if (s.status !== p.status) {
        mudar(p, { status: s.status, ...(s.sentAt && { publicado_em: s.sentAt }), ...(s.externalLink && { link: s.externalLink }), ...(s.error?.message && { erro: s.error.message }) });
        log(`${p.id}: ${s.status}${s.externalLink ? ` ${s.externalLink}` : ''}${s.error?.message ? ` (${s.error.message})` : ''}`);
      }
    } catch (e) {
      erros++;
      log(`${p.id}: erro ao consultar status (${e.message})`);
    }
  }

  // 2. agenda os próximos, respeitando a fila de cada canal
  const naFila = {};
  for (const p of posts) if (p.post_id && !FINAIS.has(p.status) && p.status !== 'error') {
    const k = `${p.rede}/${p.canal}`;
    naFila[k] = (naFila[k] ?? 0) + 1;
  }
  const pendentes = posts.filter((p) => !p.post_id && !p.status && !ehDireto(p)).sort((a, b) => new Date(a.quando) - new Date(b.quando));
  for (const p of pendentes) {
    const t = new Date(p.quando).getTime();
    if (t - agora > JANELA_H * 3600e3) continue;
    if (agora - t > ATRASO_MAX_H * 3600e3) {
      mudar(p, { status: 'perdido', erro: `horário passou há mais de ${ATRASO_MAX_H} h sem agendar` });
      log(`${p.id}: PERDIDO (era ${p.quando})`);
      continue;
    }
    const k = `${p.rede}/${p.canal}`;
    if ((naFila[k] ?? 0) >= MAX_FILA) { log(`${p.id}: fila de ${k} cheia, fica para a próxima hora`); continue; }
    const jaPassou = t - agora < 5 * 60e3;
    if (DRY) { log(`DRY_RUN: agendaria ${p.id} ${jaPassou ? 'agora' : `para ${p.quando}`}`); continue; }
    try {
      const post = await criarPost(p, jaPassou);
      mudar(p, { post_id: post.id, status: post.status, agendado_para: post.dueAt, criado_em: new Date().toISOString() });
      naFila[k] = (naFila[k] ?? 0) + 1;
      log(`${p.id}: agendado (${post.status}, sai em ${post.dueAt})`);
    } catch (e) {
      erros++;
      log(`${p.id}: ERRO ao agendar (${e.message})`);
    }
  }

  // 3. Instagram direto: grava o que já mudou (o Buffer não espera por esta parte) e publica na hora
  const diretos = posts.filter((p) => ehDireto(p) && !p.post_id && !FINAIS.has(p.status) && p.status !== 'error')
    .sort((a, b) => new Date(a.quando) - new Date(b.quando));
  if (diretos.length) await gravarGrade(mudancas, `despachar: ${Object.keys(mudancas).length} mudança(s)`);
  for (const p of diretos) {
    const t = new Date(p.quando).getTime();
    if (t - Date.now() > ADIANTO_MIN * 60e3) continue;
    if (Date.now() - t > ATRASO_MAX_H * 3600e3) {
      mudar(p, { status: 'perdido', erro: `horário passou há mais de ${ATRASO_MAX_H} h sem publicar` });
      log(`${p.id}: PERDIDO (era ${p.quando})`);
      continue;
    }
    if (DRY) { log(`DRY_RUN: publicaria ${p.id} direto no Instagram às ${p.quando}`); continue; }
    try {
      await publicarDireto(p, async (m) => { mudar(p, m); await gravarGrade({ [p.id]: mudancas[p.id] }, `despachar: ${p.id} ${m.status ?? 'link'}`); });
    } catch (e) {
      erros++;
      log(`${p.id}: ERRO no Instagram direto (${e.message})`);
    }
  }

  // 4. limpa da release os vídeos que já saíram em todas as redes
  const rel = await gh('GET', `/repos/${REPO}/releases/tags/${TAG}`);
  if (rel.status === 200) {
    for (const a of rel.json.assets) {
      const usam = posts.filter((p) => p.arquivo === a.name);
      if (!usam.length || !usam.every((p) => FINAIS.has(p.status))) continue;
      if (DRY) { log(`DRY_RUN: apagaria ${a.name}`); continue; }
      const r = await gh('DELETE', `/repos/${REPO}/releases/assets/${a.id}`);
      log(`${a.name}: ${r.status === 204 ? 'apagado da release' : `não apaguei (HTTP ${r.status})`}`);
    }
  }

  await gravarGrade(mudancas, `despachar: ${Object.keys(mudancas).length} mudança(s)`);
  const resumo = {};
  for (const p of posts) resumo[p.status ?? 'aguardando'] = (resumo[p.status ?? 'aguardando'] ?? 0) + 1;
  log(`Resumo: ${Object.entries(resumo).map(([s, n]) => `${s}=${n}`).join(' ') || 'grade vazia'}`);
  // só avisa (falha o workflow) por erro NOVO neste ciclo, para não mandar e-mail toda hora
  const comErro = posts.filter((p) => mudancas[p.id]?.status === 'error' || mudancas[p.id]?.status === 'perdido');
  if (erros || comErro.length) {
    log(`ATENÇÃO: ${comErro.map((p) => `${p.id} (${p.status}: ${p.erro ?? ''})`).join('; ')}`);
    process.exitCode = 1; // o GitHub manda e-mail quando o workflow falha
  }
}

main().catch((e) => { console.error(`ERRO: ${e.message}`); process.exit(1); });
