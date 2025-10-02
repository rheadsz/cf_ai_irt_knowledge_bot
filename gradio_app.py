import gradio as gr
import requests

# Your Cloudflare Worker URL (update with your custom domain)
API = "https://YOUR-DOMAIN.com/ask"  # Replace with your actual domain

def ask_fn(message, history):
    """Send question to IRT bot and return answer."""
    try:
        response = requests.post(
            API,
            json={"question": message},
            timeout=30,
            headers={"Content-Type": "application/json"}
        )
        response.raise_for_status()
        data = response.json()
        return data.get("answer", "No answer received.")
    
    except requests.exceptions.Timeout:
        return "⏱️ Request timed out. Please try again."
    except requests.exceptions.ConnectionError as e:
        return f"🔌 Connection error: {str(e)}\n\nThis might be a DNS or network issue in your environment."
    except requests.exceptions.HTTPError as e:
        return f"❌ HTTP error: {e.response.status_code} - {e.response.text}"
    except Exception as e:
        return f"⚠️ Error: {str(e)}"

# Create chat interface
demo = gr.ChatInterface(
    fn=ask_fn,
    title="🤖 IRT Knowledge Bot",
    description="Ask questions about WCM, login procedures, and IRT documentation.",
    examples=[
        "How do I log into WCM?",
        "How to embed images in WCM?",
        "What is the content bar?"
    ],
    theme=gr.themes.Soft()
)

if __name__ == "__main__":
    demo.launch(share=False)
