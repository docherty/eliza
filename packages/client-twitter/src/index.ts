import { TwitterPostClient } from "./post.ts";
import { TwitterSearchClient } from "./search.ts";
import { TwitterInteractionClient } from "./interactions.ts";
import { IAgentRuntime, Client } from "@ai16z/eliza";

class TwitterAllClient {
    post: TwitterPostClient;
    search: TwitterSearchClient;
    interaction: TwitterInteractionClient;

    private static instance: TwitterAllClient | null = null;

    private constructor(runtime: IAgentRuntime) {
        console.log("[TwitterAllClient] Initializing...");
        
        // Create instances using getInstance pattern
        this.post = TwitterPostClient.getInstance({ runtime });
        this.interaction = TwitterInteractionClient.getInstance({ runtime });
        
        console.log("[TwitterAllClient] All clients initialized");
    }

    public static getInstance(runtime: IAgentRuntime): TwitterAllClient {
        if (!TwitterAllClient.instance) {
            TwitterAllClient.instance = new TwitterAllClient(runtime);
        }
        return TwitterAllClient.instance;
    }
}

export const TwitterClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        console.log("Twitter client starting...");
        return TwitterAllClient.getInstance(runtime);
    },
    async stop(runtime: IAgentRuntime) {
        console.warn("Twitter client does not support stopping yet");
    },
};

export default TwitterClientInterface;
