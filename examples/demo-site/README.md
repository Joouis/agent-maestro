# Roomote Control - Demo Site

A mobile-responsive web interface for remotely controlling RooCode tasks via Agent Maestro. Deploy to Vercel and access your AI coding agent from anywhere, including mobile devices.

## Features

- **Remote Access**: Connect to your local Agent Maestro instance via reverse proxy (ngrok, Cloudflare Tunnel)
- **Mobile-First UI**: Optimized for smartphones with touch-friendly controls
- **PWA Support**: Install as a standalone app on mobile devices
- **Connection Management**: Save and reconnect to your Agent Maestro endpoints
- **Real-time Streaming**: SSE-based live task updates
- **Safe Area Support**: Proper handling of iPhone notch and home indicator

## Quick Start

### 1. Deploy to Vercel

```bash
# From the demo-site directory
pnpm install
vercel deploy
```

Or connect your GitHub repo to Vercel for automatic deployments.

### 2. Set Up Reverse Proxy

Expose your local Agent Maestro API to the internet:

**Using ngrok:**

```bash
ngrok http 23333
# Note the https://xxx.ngrok.io URL
```

**Using Cloudflare Tunnel:**

```bash
cloudflared tunnel --url localhost:23333
```

### 3. Connect from Mobile

1. Open your Vercel deployment URL on your mobile device
2. Enter your reverse proxy URL (e.g., `https://xxx.ngrok.io`)
3. Click "Connect"
4. Start controlling your RooCode tasks remotely!

## Security Considerations

⚠️ **IMPORTANT**: When deploying to production, consider these security best practices:

### Reverse Proxy Security

- **Never expose production reverse proxy URLs publicly** without proper authentication
- Use ngrok's built-in authentication: `ngrok http 23333 --basic-auth="user:password"`
- For Cloudflare Tunnel, enable [Access policies](https://developers.cloudflare.com/cloudflare-one/policies/access/) to restrict who can connect
- Consider using IP allowlists if you know your deployment's IP addresses

### CORS Configuration

The default Vercel configuration doesn't include CORS headers, which means your API will only accept requests from the same origin. If you need to add CORS headers to `vercel.json`, be specific:

```json
{
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        {
          "key": "Access-Control-Allow-Origin",
          "value": "https://your-specific-domain.vercel.app"
        }
      ]
    }
  ]
}
```

**Never use `"value": "*"`** in production as it allows any website to make requests to your backend.

### Best Practices

- Rotate reverse proxy URLs regularly
- Don't commit `.env` files with sensitive URLs
- Use environment variables for production endpoints
- Monitor your reverse proxy access logs for suspicious activity

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Mobile    │────▶│   Vercel     │────▶│  Reverse Proxy  │
│   Browser   │     │   (This App) │     │  (ngrok/CF)     │
└─────────────┘     └──────────────┘     └────────┬────────┘
                                                   │
                                                   ▼
                                         ┌─────────────────┐
                                         │  Local VS Code  │
                                         │  Agent Maestro  │
                                         │  API :23333     │
                                         └─────────────────┘
```

## Important Notes for /roo/task API Integration

### Task Completion Timing

When calling the `/roo/task` API and processing the Server-Sent Events (SSE) stream, be aware that **message events may still be emitted after the `task_completed` event**. To handle this corner case properly:

- Add a brief delay (a few seconds) after receiving `task_completed` before finalizing the task state
- Continue processing any incoming message events during this delay period
- Only reset the UI state (enable input, focus textarea) after the delay completes

This ensures all streaming message content is properly received and displayed before allowing new user input.

```javascript
// Example implementation
if (currentEvent === "task_completed") {
  showStatusMessage("Response completed! Finalizing...");
  // Wait a few seconds before finishing task to allow any remaining message events
  setTimeout(() => {
    setIsWaitingForResponse(false);
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
    showStatusMessage("Task completed!");
  }, 3000); // Adjust delay as needed based on your use case
}
```

## Getting Started (Local Development)

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
