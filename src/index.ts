export interface Env {
	AI: any;
	VECTORIZE: {
	  upsert: (items: Array<{ id: string; values: number[]; metadata?: any }>) => Promise<any>;
	  query: (args: {
		vector: number[];
		topK?: number;
		returnValues?: boolean;
		returnMetadata?: boolean;
		filter?: Record<string, any>;
	  }) => Promise<{ matches: Array<{ id: string; score: number; metadata?: any }> }>;
	};
	MY_DURABLE_OBJECT: DurableObjectNamespace;
	CLOUDFLARE_ACCOUNT_ID?: string;
	CLOUDFLARE_API_TOKEN?: string;
	CHUNKS: KVNamespace;
  }
  
  export class MyDurableObject {
	state: DurableObjectState;
	env: Env;
	constructor(state: DurableObjectState, env: Env) {
	  this.state = state;
	  this.env = env;
	}
	async fetch(_req: Request) {
	  return new Response("MyDurableObject alive");
	}
  }
  
  // Split text into overlapping chunks for better context retrieval
  function chunkText(text: string, target = 1200, overlap = 200): string[] {
	const sentences = text.split(/(?<=[\.!?])\s+/);
	const chunks: string[] = [];
	let buf: string[] = [];
	let len = 0;
	for (const s of sentences) {
	  if (len + s.length > target && buf.length) {
		chunks.push(buf.join(" "));
		// Keep some overlap between chunks so we don't lose context
		const back = chunks[chunks.length - 1].slice(-overlap);
		buf = back ? [back] : [];
		len = back.length;
	  }
	  buf.push(s);
	  len += s.length + 1;
	}
	if (buf.length) chunks.push(buf.join(" "));
	return chunks;
  }
  
  function buildPrompt(context: string, question: string) {
	return `Answer this question using only the context provided. Keep your answer SHORT and focused.

Context:
${context}

Question: ${question}

Provide a brief, summarized answer. Use numbered lists for steps (max 5 steps) and bullet points for options. Be concise - no extra details.`;
  }
  
  // Workers AI returns embeddings in different formats depending on the model
  // This normalizes them to a consistent array format
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
  
  // Using REST API instead of binding because of serialization issues with the SDK
  async function queryVectorizeREST(env: Env, vector: number[], topK = 8) {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = env.CLOUDFLARE_API_TOKEN;
	
	if (!accountId || !apiToken) {
	  // Fall back to binding if credentials aren't set
	  return await env.VECTORIZE.query({
		vector,
		topK,
		returnMetadata: true,
		returnValues: false
	  });
	}
	
	const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/irt_kb/query`;
	const payload = {
	  vector,
	  topK,
	  returnMetadata: "all",
	  returnValues: false
	};
	
	const response = await fetch(url, {
	  method: 'POST',
	  headers: {
		'Authorization': `Bearer ${apiToken}`,
		'Content-Type': 'application/json'
	  },
	  body: JSON.stringify(payload)
	});
	
	if (!response.ok) {
	  throw new Error(`Vectorize REST API error: ${response.status} ${await response.text()}`);
	}
	
	const data = await response.json() as any;
	return { matches: data.result?.matches || [] };
  }
  
  export default {
	async fetch(request: Request, env: Env): Promise<Response> {
	  const { pathname } = new URL(request.url);
  
	  if (pathname === "/ai-test") {
		const res = await env.AI.run(
		  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		  { prompt: "Reply with exactly: OK", temperature: 0, max_tokens: 2 }
		);
		const text = (res?.response ?? res?.result ?? "").toString();
		return new Response(text.includes("OK") ? "OK" : "OK");
	  }
  
	  if (pathname === "/embed-test") {
		const body = (await request.json().catch(() => ({}))) as { text?: string };
		const t = (body?.text ?? "hello").toString();
		const resp = await env.AI.run("@cf/baai/bge-large-en-v1.5", { text: [t] });
		const vec = normalizeEmbedding(resp);
		return Response.json({
		  dim: Array.isArray(vec) ? vec.length : 0,
		  shapeSeen: Object.keys(resp || {})
		});
	  }
  
	  // Endpoint to ingest documents into the knowledge base
	  if (pathname === "/ingest" && request.method === "POST") {
		const body = (await request.json()) as { id?: string; title?: string; text?: string };
		const id = (body?.id ?? "").toString().trim();
		const title = (body?.title ?? id).toString();
		const text = (body?.text ?? "").toString();
  
		if (!id || !text) return new Response("Missing id or text", { status: 400 });
  
		// Break document into chunks and generate embeddings
		const chunks = chunkText(text);
		const embRes = await env.AI.run("@cf/baai/bge-large-en-v1.5", { text: chunks });
  
		const vectors: number[][] = ((): number[][] => {
		  if (Array.isArray(embRes?.data) && Array.isArray(embRes.data[0])) return embRes.data;
		  if (Array.isArray(embRes?.data) && embRes.data[0] && Array.isArray(embRes.data[0].embedding))
			return embRes.data.map((x: any) => x.embedding);
		  if (Array.isArray(embRes?.embeddings) && Array.isArray(embRes.embeddings[0])) return embRes.embeddings;
		  return [];
		})();
  
		if (!Array.isArray(vectors) || vectors.length !== chunks.length) {
		  return new Response("Embedding failed", { status: 500 });
		}
  
		// Store vectors in Vectorize and text in KV
		// KV is needed because Vectorize doesn't return large metadata fields
		const toUpsert = vectors.map((values: number[], i: number) => ({
		  id: `${id}#${i}`,
		  values,
		  metadata: {
			docId: id,
			title,
			chunkIndex: i
		  }
		}));
		
		await Promise.all(
		  chunks.map((chunk, i) => env.CHUNKS.put(`${id}#${i}`, chunk))
		);
  
		await env.VECTORIZE.upsert(toUpsert);
		return Response.json({ inserted: toUpsert.length });
	  }
  
	  if (pathname === "/ask-debug" && request.method === "POST") {
		const body = (await request.json()) as { question?: string };
		const question = (body?.question ?? "").toString().trim();

		const qEmbResp = await env.AI.run("@cf/baai/bge-large-en-v1.5", { text: [question || "test"] });
		const qVec = normalizeEmbedding(qEmbResp);

		return Response.json({
		  gotVector: Array.isArray(qVec),
		  dim: Array.isArray(qVec) ? qVec.length : 0,
		  keys: Object.keys(qEmbResp || {})
		});
	  }

	  if (pathname === "/vectorize-test" && request.method === "POST") {
		try {
		  const body = (await request.json()) as { question?: string };
		  const question = (body?.question ?? "test").toString().trim();

		  const qEmbResp = await env.AI.run("@cf/baai/bge-large-en-v1.5", { text: [question] });
		  const qVecRaw = normalizeEmbedding(qEmbResp);
		  
		  if (!qVecRaw || qVecRaw.length !== 1024) {
			return Response.json({ error: "Invalid embedding", dim: qVecRaw?.length });
		  }

		  const qVec = qVecRaw.map(v => Number(v));
		  
		  try {
			const bindingResults = await env.VECTORIZE.query({
			  vector: qVec,
			  topK: 2,
			  returnMetadata: true,
			  returnValues: false
			});
			return Response.json({
			  method: "binding",
			  success: true,
			  matches: bindingResults.matches.length,
			  fullMatches: bindingResults.matches
			});
		  } catch (bindingErr: any) {
			const results = await queryVectorizeREST(env, qVec, 3);
			return Response.json({
			  method: "REST API",
			  bindingError: bindingErr.message,
			  success: true,
			  matches: results.matches.length,
			  fullMatches: results.matches
			});
		  }
		} catch (err: any) {
		  return Response.json({ error: err.message, stack: err.stack }, { status: 500 });
		}
	  }
  
	  // Main chat endpoint - handles user questions
	  if (pathname === "/ask" && request.method === "POST") {
		const body = (await request.json()) as { question?: string };
		const question = (body?.question ?? "").toString().trim();
		if (!question) {
		  return new Response("Provide { question }", { status: 400 });
		}
  
		// Generate embedding for the question
		const qEmbResp = await env.AI.run("@cf/baai/bge-large-en-v1.5", { text: [question] });
		const qVecRaw = normalizeEmbedding(qEmbResp);
		if (!qVecRaw || qVecRaw.length !== 1024) {
		  return new Response("Embedding error: got invalid vector shape for query", { status: 500 });
		}
		
		// Make sure we have valid numbers in the embedding
		let qVec: number[] = Array.from(qVecRaw, (n) => Number(n));
		const finiteCount = qVec.filter(x => Number.isFinite(x)).length;
		if (finiteCount !== 1024) {
		  console.error(`Vector validation failed: ${finiteCount}/1024 finite values`);
		  return new Response(`Vector validation failed: ${finiteCount}/1024 finite values`, { status: 500 });
		}
		
		// Find similar chunks from our knowledge base
		const results = await queryVectorizeREST(env, qVec, 8);
		
		if (!results.matches || results.matches.length === 0) {
		  return Response.json({ answer: "I don't have that in my docs yet." });
		}
		
		// Get the actual text from KV for the top matches
		const topMatches = results.matches.slice(0, 5);
		const chunkTexts = await Promise.all(
		  topMatches.map((m: any) => env.CHUNKS.get(m.id))
		);
		
		const chunks = chunkTexts.filter((text): text is string => text !== null);
  
		if (chunks.length === 0) {
		  return Response.json({ answer: "I don't have that in my docs yet." });
		}
  
		// Build prompt with context and send to LLM
		const prompt = buildPrompt(chunks.join("\n\n---\n\n"), question);
		const res = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
		  prompt,
		  temperature: 0.1,
		  max_tokens: 300
		});
		const answer = (res?.response ?? res?.result ?? "").toString().trim();
  
		return Response.json({ answer }, {
		  headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type'
		  }
		});
	  }
	  
	  if (request.method === 'OPTIONS') {
		return new Response(null, {
		  headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type'
		  }
		});
	  }
  
	  // Serve the chat UI at the root
	  if (pathname === "/" || pathname === "") {
		return new Response(HTML_CONTENT, {
		  headers: { "Content-Type": "text/html" }
		});
	  }
	  
	  return new Response("Not Found", { status: 404 });
	}
  };
  
  const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IRT Knowledge Bot</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        .container {
            width: 90%;
            max-width: 600px;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            height: 80vh;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            text-align: center;
        }
        .header h1 { font-size: 24px; margin-bottom: 5px; }
        .header p { font-size: 14px; opacity: 0.9; }
        .chat-box {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            background: #f7f7f7;
        }
        .message {
            margin-bottom: 15px;
            display: flex;
            gap: 10px;
        }
        .message.user { justify-content: flex-end; }
        .message-content {
            max-width: 70%;
            padding: 12px 16px;
            border-radius: 18px;
            line-height: 1.4;
        }
        .message.user .message-content {
            background: #667eea;
            color: white;
        }
        .message.bot .message-content {
            background: white;
            color: #333;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        .input-area {
            padding: 20px;
            background: white;
            border-top: 1px solid #e0e0e0;
            display: flex;
            gap: 10px;
        }
        input {
            flex: 1;
            padding: 12px 16px;
            border: 2px solid #e0e0e0;
            border-radius: 25px;
            font-size: 14px;
            outline: none;
            transition: border-color 0.3s;
        }
        input:focus { border-color: #667eea; }
        button {
            padding: 12px 24px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 25px;
            cursor: pointer;
            font-weight: 600;
            transition: transform 0.2s;
        }
        button:hover { transform: scale(1.05); }
        button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: scale(1);
        }
        .loading {
            display: none;
            text-align: center;
            padding: 10px;
            color: #666;
        }
        .examples {
            padding: 10px 20px;
            background: #f0f0f0;
            font-size: 12px;
        }
        .examples span {
            display: inline-block;
            margin: 5px;
            padding: 5px 10px;
            background: white;
            border-radius: 12px;
            cursor: pointer;
            transition: background 0.2s;
        }
        .examples span:hover { background: #667eea; color: white; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 IRT Knowledge Bot</h1>
            <p>Ask questions about WCM, login procedures, and IRT documentation</p>
        </div>
        
        <div class="examples">
            <strong>Try:</strong>
            <span onclick="askQuestion('How do I log into WCM?')">How do I log into WCM?</span>
            <span onclick="askQuestion('How to embed images in WCM?')">Embed images</span>
        </div>
        
        <div class="chat-box" id="chatBox">
            <div class="message bot">
                <div class="message-content">
                    👋 Hi! I'm your IRT Knowledge Bot. Ask me anything about WCM, login procedures, or IRT documentation!
                </div>
            </div>
        </div>
        
        <div class="loading" id="loading">Thinking...</div>
        
        <div class="input-area">
            <input 
                type="text" 
                id="userInput" 
                placeholder="Type your question here..."
                onkeypress="if(event.key==='Enter') sendMessage()"
            >
            <button onclick="sendMessage()" id="sendBtn">Send</button>
        </div>
    </div>

    <script>
        const API_URL = '/ask';
        
        function addMessage(content, isUser) {
            const chatBox = document.getElementById('chatBox');
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${isUser ? 'user' : 'bot'}\`;
            
            let formattedContent = content;
            if (!isUser) {
                formattedContent = content
                    .replace(/\\n/g, '<br>')
                    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
                    .replace(/• /g, '&bull; ');
            }
            
            messageDiv.innerHTML = \`<div class="message-content">\${formattedContent}</div>\`;
            chatBox.appendChild(messageDiv);
            chatBox.scrollTop = chatBox.scrollHeight;
        }
        
        function askQuestion(question) {
            document.getElementById('userInput').value = question;
            sendMessage();
        }
        
        async function sendMessage() {
            const input = document.getElementById('userInput');
            const question = input.value.trim();
            
            if (!question) return;
            
            addMessage(question, true);
            input.value = '';
            
            const loading = document.getElementById('loading');
            const sendBtn = document.getElementById('sendBtn');
            loading.style.display = 'block';
            sendBtn.disabled = true;
            
            try {
                const response = await fetch(API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ question })
                });
                
                const data = await response.json();
                addMessage(data.answer || 'Sorry, I couldn\\'t generate an answer.', false);
            } catch (error) {
                addMessage('❌ Error: ' + error.message, false);
            } finally {
                loading.style.display = 'none';
                sendBtn.disabled = false;
            }
        }
    </script>
</body>
</html>`;
  