import { FastifyInstance } from "fastify";
import { logger } from "../../utils/logger";
import { ExtensionController } from "../../core/controller";
import { MessageRequest } from "../types";

export async function registerClineRoutes(
  fastify: FastifyInstance,
  controller: ExtensionController,
) {
  // POST /api/v1/cline/task - Create new Cline task
  fastify.post(
    "/cline/task",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Create a new Cline task",
        description: "Creates and starts a new task using the Cline extension",
        body: { $ref: "MessageRequest#" },
        response: {
          200: {
            description: "Task created successfully",
            $ref: "TaskResponse#",
          },
          400: {
            description: "Bad request - invalid input",
            $ref: "ErrorResponse#",
          },
          500: {
            description: "Internal server error",
            $ref: "ErrorResponse#",
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { text, images } = request.body as MessageRequest;

        if (!text || text.trim() === "") {
          return reply.status(400).send({
            message: "Task description is required",
          });
        }

        if (!controller.clineAdapter.isActive) {
          return reply.status(500).send({
            message: "Cline extension is not available",
          });
        }

        await controller.clineAdapter.startNewTask({ task: text, images });

        const response = {
          id: "Cline does not support returning task ID",
          status: "completed",
          message: "Currently Cline does not support returning message",
        };

        logger.info(`Created new Cline task: ${response.id}`);
        return reply.send(response);
      } catch (error) {
        logger.error("Error creating Cline task:", error);
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    },
  );
}
