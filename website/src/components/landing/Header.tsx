import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { ExternalLink, Github } from "lucide-react";

const Header = () => {
  return (
    <motion.header
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="fixed top-0 left-0 right-0 z-50 border-b border-border/50 backdrop-blur-xl bg-background/80"
    >
      <div className="container mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/logo.svg" alt="Agent Maestro" className="size-8" />
          <span className="font-semibold text-lg">Agent Maestro</span>
        </div>

        <nav className="hidden md:flex items-center gap-8">
          <a
            href="#features"
            className="text-muted-foreground hover:text-foreground transition-colors text-sm"
          >
            Features
          </a>
          <a
            href="#demo"
            className="text-muted-foreground hover:text-foreground transition-colors text-sm"
          >
            Demo
          </a>
          <a
            href="#installation"
            className="text-muted-foreground hover:text-foreground transition-colors text-sm"
          >
            Installation
          </a>
        </nav>

        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <a
              href="https://github.com/Joouis/agent-maestro/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2"
            >
              <Github className="w-4 h-4" />
              <span className="hidden sm:inline">GitHub</span>
            </a>
          </Button>
          <Button size="sm" asChild className="glow-primary">
            <a
              href="https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2"
            >
              <span>Install</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </Button>
        </div>
      </div>
    </motion.header>
  );
};

export default Header;
