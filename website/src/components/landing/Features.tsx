import { motion } from "framer-motion";
import { Cpu, MousePointer, Radio, Settings, Shield, Zap } from "lucide-react";

const features = [
  {
    icon: Zap,
    title: "Universal API Compatibility",
    description:
      "Anthropic, OpenAI, and Gemini compatible endpoints, with Exa-backed search where supported. See the documentation for release-specific limits.",
  },
  {
    icon: MousePointer,
    title: "One-Click Setup",
    description:
      "Configure Claude Code, Claude Desktop, Codex, Gemini CLI, or Grok Build to use available GitHub Copilot models through Agent Maestro.",
  },
  {
    icon: Cpu,
    title: "Tools and Images",
    description:
      "Tool calls, tool history, and image inputs are converted for VS Code models, while client tools still run in your client.",
  },
  {
    icon: Radio,
    title: "Streaming with Heartbeats",
    description:
      "Streaming responses keep supported clients connected while a model response is pending.",
  },
  {
    icon: Settings,
    title: "Optional API Keys",
    description:
      "Separate LLM and Admin API keys plus a browser origin allowlist protect the proxy when you expose it beyond your machine.",
  },
  {
    icon: Shield,
    title: "Error Diagnostics",
    description:
      "Inspect request failures in local diagnostics. Some fields remain unredacted; review logs before sharing them.",
  },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.5,
    },
  },
};

const Features = () => {
  return (
    <section id="features" className="py-24 md:py-32 relative">
      <div className="container mx-auto px-6">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center max-w-2xl mx-auto mb-16"
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Powerful Features for
            <span className="text-gradient"> AI Development</span>
          </h2>
          <p className="text-muted-foreground text-lg">
            Everything you need to run your favorite AI coding clients on GitHub
            Copilot models from VS Code.
          </p>
        </motion.div>

        {/* Features grid */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          className="grid md:grid-cols-2 lg:grid-cols-3 gap-6"
        >
          {features.map((feature, index) => (
            <motion.div
              key={index}
              variants={itemVariants}
              className="group p-6 rounded-2xl glass-card hover:border-primary/30 transition-all duration-300"
            >
              <div className="feature-icon w-12 h-12 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
                <feature.icon className="w-6 h-6 text-primary" />
              </div>
              <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {feature.description}
              </p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
};

export default Features;
