import { ExternalLink, Github } from "lucide-react";

const Footer = () => {
  return (
    <footer className="py-12 border-t border-border/50">
      <div className="container mx-auto px-6">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          {/* Logo and copyright */}
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              <span className="text-primary-foreground font-bold text-sm">
                A
              </span>
            </div>
            <div>
              <span className="font-semibold">Agent Maestro</span>
              <p className="text-xs text-muted-foreground">
                © 2025 - {new Date().getFullYear()} Agent Maestro. Licensed
                under MIT.
              </p>
            </div>
          </div>

          {/* Links */}
          <div className="flex items-center gap-6">
            <a
              href="https://github.com/Joouis/agent-maestro/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <Github className="w-4 h-4" />
              <span>GitHub</span>
            </a>
            <a
              href="https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              <span>Marketplace</span>
            </a>
            <a
              href="https://open-vsx.org/extension/Joouis/agent-maestro"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              <span>Open VSX</span>
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
