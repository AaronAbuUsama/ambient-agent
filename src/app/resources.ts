import { openAmbientDatabase, type AmbientDatabase } from "../database/database";
import { createWhatsAppAcceptedSourceConsumer } from "../whatsapp/message-ingestion";
import { WhatsAppSessionController } from "../whatsapp/session/controller";
import { localDeployment } from "../whatsapp/session/local-deployment";
import type { AmbientDependencies } from "./ambient";
import type { AppConfig } from "./config";

export interface AppResources extends AmbientDependencies {
  readonly database: AmbientDatabase;
  readonly whatsapp: WhatsAppSessionController;
}

export async function createAppResources(
  config: AppConfig,
  onAcceptedMessage?: (input: {
    readonly observationId: string;
    readonly conversationId: string;
  }) => void,
): Promise<AppResources> {
  const database = await openAmbientDatabase(config.database.url);
  try {
    const acceptedSource = createWhatsAppAcceptedSourceConsumer(
      config.whatsapp.accountId,
      database.repositories.messageIngestion,
      (result) => {
        onAcceptedMessage?.({
          observationId: result.observationId,
          conversationId: result.conversationId,
        });
      },
    );
    const whatsapp = new WhatsAppSessionController({
      ...localDeployment({
        accountId: config.whatsapp.accountId,
        directory: config.whatsapp.dataDirectory,
        historyBackfillLimit: config.whatsapp.historyBackfillLimit,
        logLevel: config.logging.level,
      }),
      acceptedSource,
    });

    return { database, whatsapp };
  } catch (error) {
    await database.close();
    throw error;
  }
}
