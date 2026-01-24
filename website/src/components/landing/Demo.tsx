import { motion } from "framer-motion";

const demos = [
  {
    title: "One-Click Claude Code Setup",
    description:
      "Configure Claude Code to use VS Code's language models with a single command. Automatic endpoint configuration and model discovery.",
    gif: "https://media.githubusercontent.com/media/Joouis/agent-maestro/main/assets/configure-claude-code-demo.gif",
  },
  {
    title: "Agent Maestro in Action",
    description:
      "See how Agent Maestro orchestrates AI agents, manages tasks, and provides real-time updates through its powerful API.",
    gif: "https://media.githubusercontent.com/media/Joouis/agent-maestro/main/assets/agent-maestro-demo.gif",
  },
];

const Demo = () => {
  return (
    <section id="demo" className="py-24 md:py-32 relative overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 hero-gradient opacity-50" />

      <div className="container mx-auto px-6 relative z-10">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center max-w-2xl mx-auto mb-16"
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            See It <span className="text-gradient">In Action</span>
          </h2>
          <p className="text-muted-foreground text-lg">
            Watch how Agent Maestro simplifies AI integration in your
            development workflow.
          </p>
        </motion.div>

        {/* Demo cards */}
        <div className="space-y-16">
          {demos.map((demo, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.6, delay: index * 0.2 }}
              className={`flex flex-col ${
                index % 2 === 1 ? "lg:flex-row-reverse" : "lg:flex-row"
              } gap-8 lg:gap-12 items-center`}
            >
              {/* Demo GIF */}
              <div className="flex-1 w-full">
                <div className="demo-frame p-1">
                  {/* Window chrome */}
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50">
                    <div className="flex gap-1.5">
                      <div className="w-3 h-3 rounded-full bg-red-500/80" />
                      <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                      <div className="w-3 h-3 rounded-full bg-green-500/80" />
                    </div>
                    <div className="flex-1 text-center">
                      <span className="text-xs text-muted-foreground font-mono">
                        VS Code - Agent Maestro
                      </span>
                    </div>
                  </div>
                  <img
                    src={demo.gif}
                    alt={demo.title}
                    className="w-full h-auto"
                    loading="lazy"
                  />
                </div>
              </div>

              {/* Demo description */}
              <div className="flex-1 lg:max-w-md">
                <h3 className="text-2xl font-bold mb-4">{demo.title}</h3>
                <p className="text-muted-foreground leading-relaxed">
                  {demo.description}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Demo;
