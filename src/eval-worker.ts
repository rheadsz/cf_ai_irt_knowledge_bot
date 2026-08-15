import mainWorker, { MyDurableObject } from "./index";

export { MyDurableObject };

interface Env {
  AI: any;
  VECTORIZE: {
    query: (args: {
      vector: number[];
      topK?: number;
      returnValues?: boolean;
      returnMetadata?: boolean;
      filter?: Record<string, any>;
    }) => Promise<{ matches: Array<{ id: string; score: number; metadata?: any }> }>;
  };
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CHUNKS: KVNamespace;
}

function normalizeEmbedding(resp: any): number[] | null {
  if (Array.isArray(resp?.data) && Array.isArray(resp.data[0])) {
    return resp.data[0] as number[];
  }
  if (Array.isArray(resp?.data) && resp.data[0] && Array.isArray(resp.data[0].embedding)) {
    return resp.data[0].embedding as number[];
  }
  if (Array.isArray(resp?.embeddings) && Array.isArray(resp.embeddings[0])) {
    return resp.embeddings[0] as number[];
  }
  if (Array.isArray(resp?.embedding)) {
    return resp.embedding as number[];
  }
  return null;
}

async function queryVectorizeREST(env: Env, vector: number[], topK = 8) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    return env.VECTORIZE.query({
      vector,
      topK,
      returnMetadata: true,
      returnValues: false,
    });
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/irt_kb/query`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      vector,
      topK,
      returnMetadata: "all",
      returnValues: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Vectorize REST API error: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as any;
  return { matches: data.result?.matches || [] };
}

function buildPrompt(context: string, question: string) {
  return `Answer this question using only the context provided. Keep your answer SHORT and focused.\n\nContext:\n${context}\n\nQuestion: ${question}\n\nProvide a brief, summarized answer. Use numbered lists for steps (max 5 steps) and bullet points for options. Be concise - no extra details.`;
}

async function handleEvaluationAsk(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { question?: string };
  const question = (body?.question ?? "").toString().trim();

  if (!question) {
    return Response.json({ error: "Provide { question }" }, { status: 400 });
  }

  const qEmbResp = await env.AI.run("@cf/baai/bge-large-en-v1.5", { text: [question] });
  const qVecRaw = normalizeEmbedding(qEmbResp);

  if (!qVecRaw || qVecRaw.length !== 1024) {
    return Response.json({ error: "Embedding error: invalid query vector" }, { status: 500 });
  }

  const qVec = Array.from(qVecRaw, (value) => Number(value));
  if (qVec.some((value) => !Number.isFinite(value))) {
    return Response.json({ error: "Embedding error: query vector contains invalid values" }, { status: 500 });
  }

  const results = await queryVectorizeREST(env, qVec, 8);
  const topMatches = (results.matches || []).slice(0, 5);

  const retrievedChunks = await Promise.all(
    topMatches.map(async (match: any) => ({
      id: match.id,
      score: match.score,
      metadata: match.metadata ?? null,
      text: await env.CHUNKS.get(match.id),
    }))
  );

  const usableChunks = retrievedChunks.filter(
    (chunk): chunk is { id: string; score: number; metadata: any; text: string } =>
      typeof chunk.text === "string" && chunk.text.length > 0
  );

  if (usableChunks.length === 0) {
    return Response.json({
      answer: "I don't have that in my docs yet.",
      retrieved_chunks: retrievedChunks,
    });
  }

  const context = usableChunks.map((chunk) => chunk.text).join("\n\n---\n\n");
  const prompt = buildPrompt(context, question);

  const res = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    prompt,
    temperature: 0.1,
    max_tokens: 300,
  });

  const answer = (res?.response ?? res?.result ?? "").toString().trim();

  return Response.json(
    {
      answer,
      retrieved_chunks: retrievedChunks,
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    }
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/ask-eval" && request.method === "POST") {
      try {
        return await handleEvaluationAsk(request, env);
      } catch (error: any) {
        return Response.json(
          { error: error?.message ?? "Evaluation request failed" },
          { status: 500 }
        );
      }
    }

    return mainWorker.fetch(request, env as any);
  },
};
