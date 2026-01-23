import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

const Installation = () => {
  const [copied, setCopied] = useState(false);
  const command = "ext install Joouis.agent-maestro";

  const handleCopy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section
      id="installation"
      className="py-24 md:py-32 relative overflow-hidden"
    >
      {/* Background */}
      <div className="absolute inset-0 hero-gradient opacity-30" />

      <div className="container mx-auto px-6 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="max-w-3xl mx-auto text-center"
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Ready to <span className="text-gradient">Get Started?</span>
          </h2>
          <p className="text-muted-foreground text-lg mb-10">
            Install Agent Maestro in seconds and unlock the full potential of AI
            in VS Code.
          </p>

          {/* Command block */}
          <div className="glass-card rounded-xl p-6 mb-8">
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 text-left">
                <p className="text-xs text-muted-foreground mb-2">
                  Run in VS Code Quick Open (Ctrl+P / Cmd+P)
                </p>
                <code className="font-mono text-sm md:text-base text-foreground">
                  <span className="text-primary">ext install</span>{" "}
                  Joouis.agent-maestro
                </code>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCopy}
                className="shrink-0 hover:bg-primary/10"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-green-500" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Alternative install options */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button size="lg" asChild className="glow-primary w-full sm:w-auto">
              <a
                href="https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro"
                target="_blank"
                rel="noopener noreferrer"
              >
                VS Code Marketplace
              </a>
            </Button>
            <Button
              variant="outline"
              size="lg"
              asChild
              className="w-full sm:w-auto"
            >
              <a
                href="https://open-vsx.org/extension/Joouis/agent-maestro"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open VSX Registry
              </a>
            </Button>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default Installation;
