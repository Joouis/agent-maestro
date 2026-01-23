import { motion } from "framer-motion";
import { Download, Rocket, Terminal } from "lucide-react";

const steps = [
  {
    icon: Download,
    step: "01",
    title: "Install Extension",
    description:
      "Install Agent Maestro from VS Code Marketplace or Open VSX Registry.",
  },
  {
    icon: Terminal,
    step: "02",
    title: "Run Setup Command",
    description:
      "Use Command Palette to run one-click setup for Claude Code, Codex, or Gemini CLI.",
  },
  {
    icon: Rocket,
    step: "03",
    title: "Start Building",
    description:
      "Use your favorite AI coding tools with VS Code's built-in language models.",
  },
];

const HowItWorks = () => {
  return (
    <section className="py-24 md:py-32 relative">
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
            Get Started in <span className="text-gradient">Minutes</span>
          </h2>
          <p className="text-muted-foreground text-lg">
            Three simple steps to supercharge your AI development workflow.
          </p>
        </motion.div>

        {/* Steps */}
        <div className="relative">
          {/* Connection line */}
          <div className="hidden lg:block absolute top-1/2 left-0 right-0 h-px bg-gradient-to-r from-transparent via-border to-transparent -translate-y-1/2" />

          <div className="grid md:grid-cols-3 gap-8 lg:gap-12">
            {steps.map((step, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="relative text-center"
              >
                {/* Step number */}
                <div className="relative z-10 mx-auto mb-6">
                  <div className="w-20 h-20 rounded-2xl glass-card flex items-center justify-center mx-auto glow-primary">
                    <step.icon className="w-8 h-8 text-primary" />
                  </div>
                  <div className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-primary flex items-center justify-center">
                    <span className="text-xs font-bold text-primary-foreground">
                      {step.step}
                    </span>
                  </div>
                </div>

                <h3 className="text-xl font-semibold mb-3">{step.title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed max-w-xs mx-auto">
                  {step.description}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default HowItWorks;
