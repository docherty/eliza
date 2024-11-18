import { Tweet } from "agent-twitter-client";
import fs from "fs";
import { composeContext } from "@ai16z/eliza/src/context.ts";
import { generateText } from "@ai16z/eliza/src/generation.ts";
import { embeddingZeroVector } from "@ai16z/eliza/src/memory.ts";
import { IAgentRuntime, ModelClass } from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza/src/uuid.ts";
import { ClientBase } from "./base.ts";

interface PostIntervals {
    minMinutes: number;
    maxMinutes: number;
}

declare module "@ai16z/eliza" {
    interface CharacterSettings {
        postIntervals?: PostIntervals;
    }
}

const twitterPostTemplate = `{{timeline}}

# Knowledge
{{knowledge}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{postDirections}}

{{providers}}

{{recentPosts}}

{{characterPostExamples}}

# Task: Generate a post in the voice and style of {{agentName}}, aka @{{twitterUserName}}
Write a single sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Try to write something totally different than previous posts. Do not add commentary or acknowledge this request, just write the post.
Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.`;

export class TwitterPostClient extends ClientBase {
    private static instance: TwitterPostClient;

    public static override getInstance(config: { runtime: IAgentRuntime }): TwitterPostClient {
        if (!TwitterPostClient.instance) {
            TwitterPostClient.instance = new TwitterPostClient({ runtime: config.runtime });
        }
        return TwitterPostClient.instance;
    }

    protected constructor(config: { runtime: IAgentRuntime }) {
        super({ runtime: config.runtime });
        
        // Add extensive debug logging
        /*
        console.log("\n=== Runtime Debug Info ===");
        console.log("Runtime initialized:", !!this.runtime);
        console.log("Runtime type:", typeof this.runtime);
        console.log("Runtime properties:", Object.keys(this.runtime));
        */

        /*
        console.log("\n=== MessageManager Debug Info ===");
        console.log("MessageManager available:", !!this.runtime.messageManager);
        if (this.runtime.messageManager) {
            console.log("MessageManager type:", typeof this.runtime.messageManager);
            console.log("MessageManager properties:", Object.keys(this.runtime.messageManager));
            console.log("MessageManager methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(this.runtime.messageManager)));
            
            // Test if getEmbedding exists in different ways
            console.log("\n=== GetEmbedding Function Debug ===");
            console.log("getEmbedding as direct property:", 'getEmbedding' in this.runtime.messageManager);
            console.log("getEmbedding type:", typeof this.runtime.messageManager.getEmbedding);
            console.log("getEmbedding on prototype:", 'getEmbedding' in Object.getPrototypeOf(this.runtime.messageManager));
        }
        */
    }

    protected override onReady(): void {
        // Get post intervals from character settings
        const POST_INTERVAL_MIN = this.runtime.character.settings?.postIntervals?.minMinutes ?? 160;
        const POST_INTERVAL_MAX = this.runtime.character.settings?.postIntervals?.maxMinutes ?? 480;
        
        const getRandomDelay = () => {
            const delay = (Math.floor(Math.random() * (POST_INTERVAL_MAX - POST_INTERVAL_MIN + 1)) + POST_INTERVAL_MIN) * 60 * 1000;
            console.log(`Setting next tweet delay: ${delay/1000/60} minutes`);
            return delay;
        };

        const waitForEmbeddingSystem = async () => {
            let attempts = 0;
            const maxAttempts = 10;
            
            while (attempts < maxAttempts) {
                try {
                    console.log(`Checking embedding system (attempt ${attempts + 1}/${maxAttempts})...`);
                    
                    if (!this.runtime.messageManager) {
                        console.log('MessageManager not initialized');
                        throw new Error('MessageManager not initialized');
                    }

                    if (!this.runtime.messageManager.addEmbeddingToMemory) {
                        console.log('addEmbeddingToMemory function not available');
                        throw new Error('addEmbeddingToMemory function not available');
                    }

                    // Test the embedding system
                    console.log('Testing embedding system with test message...');
                    const testMemory: Memory = {
                        id: stringToUuid('test'),
                        userId: this.runtime.agentId,
                        agentId: this.runtime.agentId,
                        roomId: stringToUuid('test-room'),
                        content: { text: 'test message' },
                    };
                    
                    const memoryWithEmbedding = await this.runtime.messageManager.addEmbeddingToMemory(testMemory);
                    console.log('Embedding test successful:', memoryWithEmbedding.embedding ? 'embedding received' : 'no embedding received');
                    
                    return true;
                } catch (error) {
                    console.error(`Embedding system check failed (attempt ${attempts + 1}/${maxAttempts}):`, error);
                }
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
            return false;
        };

        const generateNewTweetLoop = async () => {
            console.log('Starting new tweet generation cycle');
            
            // Wait for embedding system before generating tweet
            console.log('Checking embedding system availability...');
            const embeddingReady = await waitForEmbeddingSystem();
            
            if (!embeddingReady) {
                console.error("Failed to initialize embedding system after multiple attempts");
                console.log("Will retry in 30 seconds...");
                // Retry the entire loop after a delay
                setTimeout(generateNewTweetLoop, 30000); // Wait 30 seconds before retrying
                return;
            }
            
            console.log('Embedding system ready, proceeding with tweet generation');
            await this.generateNewTweet();
            const nextDelay = getRandomDelay();
            console.log(`Scheduling next tweet for ${new Date(Date.now() + nextDelay).toLocaleString()}`);
            setTimeout(generateNewTweetLoop, nextDelay);
        };
        
        console.log('TwitterPostClient initialized, starting first tweet cycle');
        setTimeout(generateNewTweetLoop, getRandomDelay());
    }

    private async generateNewTweet() {
        console.log("\n=== Starting Tweet Generation Process ===");
        try {
            console.log("Ensuring user exists...");
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.runtime.getSetting("TWITTER_USERNAME"),
                this.runtime.character.name,
                "twitter"
            );

            console.log("Creating empty message for state composition...");
            const emptyMessage = {
                id: stringToUuid(`empty-message-${Date.now()}`),
                userId: this.runtime.agentId,
                roomId: stringToUuid("twitter_generate_room"),
                agentId: this.runtime.agentId,
                content: { 
                    text: "",
                    action: "",
                    source: "twitter"
                },
                user: this.runtime.character.name,
                createdAt: Date.now(),
                embedding: embeddingZeroVector
            };
            console.log("Empty message created:", JSON.stringify(emptyMessage, null, 2));

            console.log("Getting formatted timeline...");
            const timeline = await this.getFormattedHomeTimeline();
            console.log("\n=== Timeline Sample ===\n", timeline.slice(0, 500));

            // Verify timeline content
            if (!timeline || typeof timeline !== 'string') {
                throw new Error('Invalid timeline format received');
            }

            console.log("\nComposing state with timeline length:", timeline.length);
            const stateData = {
                twitterUserName: this.runtime.getSetting("TWITTER_USERNAME"),
                timeline: timeline,
                recentMessages: [],
                recentMessagesData: [],
                actors: "",
                actorsData: [],
            };
            /*
            console.log("\n=== State Data ===\n", JSON.stringify(stateData, null, 2));

            // Add debug logging for runtime
            console.log("\n=== Runtime Debug Info ===");
            console.log("Runtime initialized:", !!this.runtime);
            console.log("Runtime type:", typeof this.runtime);
            console.log("Runtime properties:", Object.keys(this.runtime));
            
            console.log("\n=== MessageManager Debug Info ===");
            console.log("MessageManager available:", !!this.runtime.messageManager);
            if (this.runtime.messageManager) {
                console.log("MessageManager type:", typeof this.runtime.messageManager);
                console.log("MessageManager properties:", Object.keys(this.runtime.messageManager));
            }
            */

            console.log("\nCalling composeState...");
            const state = await this.runtime.composeState(emptyMessage, stateData);

            if (!state) {
                throw new Error("Failed to compose state");
            }

            console.log("State composed successfully");

            // Generate new tweet
            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.twitterPostTemplate ||
                    twitterPostTemplate,
            });

            console.log("\n=== Generation Context ===\n", context);

            console.log("\nGenerating tweet text...");
            const newTweetContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            console.log("\n=== Raw Generated Content ===\n", newTweetContent);

            const slice = newTweetContent.replaceAll(/\\n/g, "\n").trim();

            const contentLength = 240;

            let content = slice.slice(0, contentLength);
            // if its bigger than 280, delete the last line
            if (content.length > 280) {
                content = content.slice(0, content.lastIndexOf("\n"));
            }
            if (content.length > contentLength) {
                // slice at the last period
                content = content.slice(0, content.lastIndexOf("."));
            }

            // if it's still too long, get the period before the last period
            if (content.length > contentLength) {
                content = content.slice(0, content.lastIndexOf("."));
            }

            console.log("\n=== Final Tweet Content ===\n", content);

            try {
                console.log("\nSending tweet to Twitter...");
                const result = await this.requestQueue.add(
                    async () => await this.twitterClient.sendTweet(content)
                );
                console.log("Tweet API response received");
                
                // read the body of the response
                const body = await result.json();
                console.log("Tweet response body:", body);

                const tweetResult = body.data.create_tweet.tweet_results.result;

                const tweet = {
                    id: tweetResult.rest_id,
                    text: tweetResult.legacy.full_text,
                    conversationId: tweetResult.legacy.conversation_id_str,
                    createdAt: tweetResult.legacy.created_at,
                    userId: tweetResult.legacy.user_id_str,
                    inReplyToStatusId:
                        tweetResult.legacy.in_reply_to_status_id_str,
                    permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
                    hashtags: [],
                    mentions: [],
                    photos: [],
                    thread: [],
                    urls: [],
                    videos: [],
                } as Tweet;

                const postId = tweet.id;
                const conversationId =
                    tweet.conversationId + "-" + this.runtime.agentId;
                const roomId = stringToUuid(conversationId);

                // make sure the agent is in the room
                await this.runtime.ensureRoomExists(roomId);
                await this.runtime.ensureParticipantInRoom(
                    this.runtime.agentId,
                    roomId
                );

                await this.cacheTweet(tweet);

                await this.runtime.messageManager.createMemory({
                    id: stringToUuid(postId + "-" + this.runtime.agentId),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: newTweetContent.trim(),
                        url: tweet.permanentUrl,
                        source: "twitter",
                    },
                    roomId,
                    embedding: embeddingZeroVector,
                    createdAt: tweet.timestamp * 1000,
                });
            } catch (error) {
                console.error("Error sending tweet:", error);
            }
        } catch (error) {
            console.error("Error in tweet generation process:", error);
            // Log more details about the error
            if (error instanceof Error) {
                console.error("Error stack:", error.stack);
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
            return this.generateNewTweet();
        }
    }

    protected async getFormattedHomeTimeline(): Promise<string> {
        let homeTimeline = [];

        if (!fs.existsSync("tweetcache")) fs.mkdirSync("tweetcache");
        
        try {
            if (fs.existsSync("tweetcache/home_timeline.json")) {
                const rawData = fs.readFileSync("tweetcache/home_timeline.json", "utf-8");
                try {
                    homeTimeline = JSON.parse(rawData);
                    console.log("Successfully loaded timeline from cache");
                } catch (parseError) {
                    console.error("Error parsing home timeline JSON:", parseError);
                    homeTimeline = [];
                }
            } else {
                console.log("Fetching new timeline data...");
                homeTimeline = await this.fetchHomeTimeline(50);
                fs.writeFileSync(
                    "tweetcache/home_timeline.json",
                    JSON.stringify(homeTimeline, null, 2)
                );
            }

            console.log("Raw timeline entries:", homeTimeline.length);
            console.log("Sample raw tweet:", JSON.stringify(homeTimeline[0], null, 2));
            
            homeTimeline = homeTimeline.filter(tweet => {
                if (!tweet || typeof tweet !== 'object') {
                    console.log("Filtered out invalid tweet object:", tweet);
                    return false;
                }
                
                const isValid = tweet.text && 
                              typeof tweet.text === 'string' &&
                              tweet.name && 
                              typeof tweet.name === 'string' &&
                              tweet.username &&
                              typeof tweet.username === 'string';
                
                if (!isValid) {
                    console.log("Filtered out tweet missing required fields:", JSON.stringify(tweet, null, 2));
                }
                return isValid;
            });

            console.log("Filtered timeline entries:", homeTimeline.length);
            if (homeTimeline.length > 0) {
                console.log("Sample filtered tweet:", JSON.stringify(homeTimeline[0], null, 2));
            }

            if (homeTimeline.length === 0) {
                console.warn("No valid timeline entries found after filtering");
                return "# Timeline Unavailable\n\nNo valid timeline entries found.";
            }

            const formattedTimeline = `# ${this.runtime.character.name}'s Home Timeline\n\n` +
                homeTimeline
                    .map((tweet) => {
                        try {
                            const formatted = `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}\nText: ${tweet.text}\n---\n`;
                            return formatted;
                        } catch (error) {
                            console.error("Error formatting tweet:", error, JSON.stringify(tweet, null, 2));
                            return "";
                        }
                    })
                    .filter(entry => entry !== "") // Remove any failed entries
                    .join("\n");

            console.log("Formatted timeline sample:", formattedTimeline.slice(0, 500) + "...");
            
            // Verify the final string is valid
            if (typeof formattedTimeline !== 'string' || formattedTimeline.length === 0) {
                console.error("Invalid formatted timeline generated");
                return "# Timeline Unavailable\n\nError formatting timeline data.";
            }

            return formattedTimeline;
        } catch (error) {
            console.error("Error fetching home timeline:", error);
            return "# Timeline Unavailable\n\nUnable to fetch timeline data at this time.";
        }
    }
}
