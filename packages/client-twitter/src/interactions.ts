import { SearchMode, Tweet } from "agent-twitter-client";
import fs from "fs";
import { composeContext } from "@ai16z/eliza/src/context.ts";
import {
    generateMessageResponse,
    generateShouldRespond,
} from "@ai16z/eliza/src/generation.ts";
import {
    messageCompletionFooter,
    shouldRespondFooter,
} from "@ai16z/eliza/src/parsing.ts";
import {
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
} from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza/src/uuid.ts";
import { ClientBase } from "./base.ts";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";
import path from "path";
import { embeddingZeroVector } from "@ai16z/eliza/src/memory.ts";

class BannedWordsFilter {
    private static getBannedWords(runtime: IAgentRuntime): Set<string> {
        const bannedWords = runtime.getSetting("bannedWords") || [];
        return new Set(bannedWords);
    }
    
    static shouldIgnoreTweet(tweet: Tweet, runtime: IAgentRuntime): boolean {
        if (!tweet?.text) return true;
        const normalizedText = tweet.text.toLowerCase();
        return [...this.getBannedWords(runtime)].some(word => normalizedText.includes(word.toLowerCase()));
    }
}

export const twitterMessageHandlerTemplate =
    `{{timeline}}

# Knowledge
{{knowledge}}

# Task: Generate a post for the character {{agentName}}.
About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# Task: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}):
{{currentPost}}

` + messageCompletionFooter;

export const twitterShouldRespondTemplate = `
# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

{{agentName}} should respond to messages that are directed at them, or participate in conversations that are interesting or relevant to their background, IGNORE messages that are irrelevant to them, and should STOP if the conversation is concluded.

{{agentName}} is in a room with other users and wants to be conversational, but not annoying.
{{agentName}} should RESPOND to messages that are directed at them, or participate in conversations that are interesting or relevant to their background.
If a message is not interesting or relevant, {{agentName}} should IGNORE.
Unless directly RESPONDing to a user, {{agentName}} should IGNORE messages that are very short or do not contain much information.
If a user asks {{agentName}} to stop talking, {{agentName}} should STOP.
If {{agentName}} concludes a conversation and isn't part of the conversation anymore, {{agentName}} should STOP.

{{recentPosts}}

# Instructions
Determine if {{agentName}} should respond to this tweet. Consider:
1. Is the tweet directed at {{agentName}}?
2. Is the content relevant to {{agentName}}'s interests and background?
3. Is there enough substance to warrant a response?
4. Does a response from {{agentName}} risk becoming annoying or repetitive?
5. Does the response from {{agentName}} add value to the conversation?

Respond with one of:
[RESPOND] - If {{agentName}} should respond
[IGNORE] - If the tweet should be ignored
[STOP] - If the conversation is concluded

${shouldRespondFooter}`;

export class TwitterInteractionClient extends ClientBase {
    private static instance: TwitterInteractionClient;
    private processedTweetIds: Set<string> = new Set();
    private tweetCacheFile: string;
    private lastCheckedTweetId: number | null = null;
    private tweetCacheFilePath: string;

    public static override getInstance(config: { runtime: IAgentRuntime }): TwitterInteractionClient {
        console.log("[TwitterInteractions] getInstance called");
        if (!TwitterInteractionClient.instance) {
            console.log("[TwitterInteractions] Creating new instance");
            TwitterInteractionClient.instance = new TwitterInteractionClient(config.runtime);
        }
        return TwitterInteractionClient.instance;
    }

    protected constructor(runtime: IAgentRuntime) {
        console.log("[TwitterInteractions] Starting constructor");
        super({ runtime });
        
        // Debug logging
        console.log("Runtime initialization check:", {
            hasRuntime: !!runtime,
            hasCharacter: !!runtime?.character,
            characterName: runtime?.character?.name,
            hasTwitterUsername: !!runtime?.getSetting("TWITTER_USERNAME")
        });
        
        // Initialize tweet cache file path
        this.tweetCacheFile = path.join(
            this.baseDir,
            "tweetcache",
            "processed_tweets.json"
        );
        
        // Load previously processed tweets
        this.loadProcessedTweets();
        
        console.log("[TwitterInteractions] Constructor completed");
    }

    private loadProcessedTweets() {
        try {
            if (fs.existsSync(this.tweetCacheFile)) {
                const data = fs.readFileSync(this.tweetCacheFile, 'utf-8');
                const tweetIds = JSON.parse(data);
                this.processedTweetIds = new Set(tweetIds);
                console.log(`[TwitterInteractions] Loaded ${this.processedTweetIds.size} processed tweet IDs`);
            }
        } catch (error) {
            console.error("[TwitterInteractions] Error loading processed tweets:", error);
            this.processedTweetIds = new Set();
        }
    }

    private saveProcessedTweets() {
        try {
            const dir = path.dirname(this.tweetCacheFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(
                this.tweetCacheFile, 
                JSON.stringify(Array.from(this.processedTweetIds))
            );
        } catch (error) {
            console.error("[TwitterInteractions] Error saving processed tweets:", error);
        }
    }

    protected override onReady(): void {
        console.log("[TwitterInteractions] onReady called");
        const handleTwitterInteractionsLoop = () => {
            console.log("[TwitterInteractions] Running interaction loop");
            this.handleTwitterInteractions().catch(error => {
                console.error("[TwitterInteractions] Error handling interactions:", error);
            });
            setTimeout(
                handleTwitterInteractionsLoop,
                20000
            );
        };
        
        console.log("[TwitterInteractions] Starting interaction loop");
        handleTwitterInteractionsLoop();
    }

    private async handleTwitterInteractions() {
        console.log("\n=== Starting Twitter Interaction Cycle ===");
        try {
            const query = `@${this.runtime.getSetting("TWITTER_USERNAME")}`;
            console.log(`🔍 Searching for mentions with query: ${query}`);
            
            const mentions = await this.fetchSearchTweets(
                query,
                20,
                SearchMode.Latest
            );

            if (!mentions || !mentions.tweets || mentions.tweets.length === 0) {
                console.log("ℹ️ No new mentions found");
                return;
            }

            console.log(`📥 Found ${mentions.tweets.length} potential mentions to process`);

            // Sort tweets by timestamp (oldest first to maintain conversation flow)
            const sortedTweets = mentions.tweets.sort((a, b) => {
                const aTime = new Date(a.createdAt).getTime();
                const bTime = new Date(b.createdAt).getTime();
                return aTime - bTime;
            });

            for (const tweet of sortedTweets) {
                console.log(`\n--- Processing Tweet ${tweet.id} ---`);
                console.log(`From: @${tweet.username}`);
                console.log(`Content: ${tweet.text}`);
                
                // Skip if we've already processed this tweet
                if (this.processedTweetIds.has(tweet.id)) {
                    console.log(`⏭️ Skipping already processed tweet: ${tweet.id}`);
                    continue;
                }

                // Skip our own tweets
                if (tweet.userId === this.twitterUserId) {
                    console.log(`🤖 Skipping own tweet: ${tweet.id}`);
                    this.processedTweetIds.add(tweet.id);
                    continue;
                }

                // Skip tweets with banned words
                if (BannedWordsFilter.shouldIgnoreTweet(tweet, this.runtime)) {
                    console.log(`🚫 Skipping tweet with banned words: ${tweet.id}`);
                    this.processedTweetIds.add(tweet.id);
                    continue;
                }

                try {
                    console.log(`\n🔄 Processing new interaction for tweet: ${tweet.id}`);
                    
                    // Create a room for this conversation if it doesn't exist
                    const roomId = stringToUuid(tweet.conversationId + "-" + this.runtime.agentId);
                    console.log(`📝 Ensuring room exists: ${roomId}`);
                    await this.runtime.ensureRoomExists(roomId);
                    
                    // Ensure the tweeting user exists in our system
                    const tweetUserId = stringToUuid(tweet.userId);
                    console.log(`👤 Ensuring user connection for: @${tweet.username}`);
                    await this.runtime.ensureConnection(
                        tweetUserId,
                        roomId,
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );

                    // Create memory for the tweet
                    const memory = {
                        id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                        userId: tweetUserId,
                        content: {
                            text: tweet.text,
                            url: tweet.permanentUrl,
                            source: "twitter",
                            inReplyTo: tweet.inReplyToStatusId
                                ? stringToUuid(tweet.inReplyToStatusId + "-" + this.runtime.agentId)
                                : undefined,
                        },
                        agentId: this.runtime.agentId,
                        roomId,
                        embedding: embeddingZeroVector,
                        createdAt: new Date(tweet.createdAt).getTime(),
                    };

                    // First, check if we should respond
                    console.log(`🤔 Checking if we should respond to tweet: ${tweet.id}`);
                    const shouldRespond = await this.shouldRespondToTweet(memory);
                    
                    if (shouldRespond) {
                        console.log(`✅ Decided to respond to tweet: ${tweet.id}`);
                        // Generate and send the response
                        const response = await this.generateResponse(memory);
                        if (response) {
                            console.log(`📤 Sending response: ${response}`);
                            await this.sendTweetResponse(response, tweet.id);
                        } else {
                            console.log(`⚠️ No response generated for tweet: ${tweet.id}`);
                        }
                    } else {
                        console.log(`❌ Decided not to respond to tweet: ${tweet.id}`);
                    }

                    // Mark tweet as processed
                    this.processedTweetIds.add(tweet.id);
                    console.log(`✨ Successfully processed tweet: ${tweet.id}`);
                } catch (error) {
                    console.error(`❌ Error processing tweet ${tweet.id}:`, error);
                }
            }

            // Save the updated processed tweets list
            this.saveProcessedTweets();
            console.log("\n=== Completed Twitter Interaction Cycle ===\n");

        } catch (error) {
            console.error("❌ Error in handleTwitterInteractions:", error);
        }
    }

/*
private async handleTwitterInteractions() {
    console.log("Checking Twitter interactions");
    try {
        // Check for mentions
        const tweetCandidates = (
            await this.fetchSearchTweets(
                `@${this.runtime.getSetting("TWITTER_USERNAME")}`,
                20,
                SearchMode.Latest
            )
        ).tweets;

        // Filter out tweets containing banned words before processing
        const filteredTweets = tweetCandidates.filter(tweet => !BannedWordsFilter.shouldIgnoreTweet(tweet));

        const uniqueTweetCandidates = [...new Set(filteredTweets)];

        const sortedAndFilteredTweets = uniqueTweetCandidates
            .sort((a, b) => a.id.localeCompare(b.id))
            .filter((tweet) => tweet.userId !== this.twitterUserId);

        // for each tweet candidate, handle the tweet
        for (const tweet of sortedAndFilteredTweets) {
            if (
                !this.lastCheckedTweetId ||
                parseInt(tweet.id) > this.lastCheckedTweetId
            ) {
                const conversationId =
                    tweet.conversationId + "-" + this.runtime.agentId;

                const roomId = stringToUuid(conversationId);

                const userIdUUID = stringToUuid(tweet.userId as string);

                await this.runtime.ensureConnection(
                    userIdUUID,
                    roomId,
                    tweet.username,
                    tweet.name,
                    "twitter"
                );

                await buildConversationThread(tweet, this);

                const message = {
                    content: { text: tweet.text },
                    agentId: this.runtime.agentId,
                    userId: userIdUUID,
                    roomId,
                };

                await this.handleTweet({
                    tweet,
                    message,
                });

                // Update the last checked tweet ID after processing each tweet
                this.lastCheckedTweetId = parseInt(tweet.id);

                try {
                    if (this.lastCheckedTweetId) {
                        fs.writeFileSync(
                            this.tweetCacheFilePath,
                            this.lastCheckedTweetId.toString(),
                            "utf-8"
                        );
                    }
                } catch (error) {
                    console.error(
                        "Error saving latest checked tweet ID to file:",
                        error
                    );
                }
            }
        }

        // Save the latest checked tweet ID to the file
        try {
            if (this.lastCheckedTweetId) {
                fs.writeFileSync(
                    this.tweetCacheFilePath,
                    this.lastCheckedTweetId.toString(),
                    "utf-8"
                );
            }
        } catch (error) {
            console.error(
                "Error saving latest checked tweet ID to file:",
                error
            );
        }

        console.log("Finished checking Twitter interactions");
    } catch (error) {
        console.error("Error handling Twitter interactions:", error);
    }
}
*/


    // Add these new methods to handle response generation and sending
    private async shouldRespondToTweet(memory: Memory): Promise<boolean> {
        try {
            console.log(`🔍 Preparing context for tweet evaluation...`);
            
            // Get recent posts for context
            const recentPosts = await this.runtime.messageManager.getMemories({
                roomId: memory.roomId,
                count: 5,
                unique: true
            });
            
            const recentPostsText = recentPosts
                .map(m => `${m.userId === this.runtime.agentId ? 'Bot' : 'User'}: ${m.content.text}`)
                .join('\n');

            // Prepare context with required fields
            const context = {
                agentName: this.runtime.character.name || 'Bot',
                twitterUserName: this.runtime.getSetting("TWITTER_USERNAME") || '',
                bio: this.runtime.character.bio || '',
                currentPost: memory.content.text || '',
                recentPosts: recentPostsText || 'No recent posts',
            };

            console.log(`📋 Context prepared:`, {
                agentName: context.agentName,
                twitterUserName: context.twitterUserName,
                currentPost: context.currentPost,
                recentPostsCount: recentPosts.length
            });

            const shouldRespond = await generateShouldRespond(
                this.runtime,
                twitterShouldRespondTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => context[key] || ''),
                ModelClass.Completion
            );

            console.log(`🤖 Should respond decision: ${shouldRespond}`);
            return shouldRespond === "RESPOND";
        } catch (error) {
            console.error("❌ Error in shouldRespondToTweet:", error);
            console.error("Error details:", {
                message: error.message,
                stack: error.stack,
                runtime: !!this.runtime,
                character: !!this.runtime?.character,
                settings: !!this.runtime?.getSetting
            });
            return false;
        }
    }

    private async generateResponse(memory: Memory): Promise<string | null> {
        try {
            console.log(`💭 Generating response for tweet...`);
            
            // Similar context preparation as above
            const context = {
                agentName: this.runtime.character.name || 'Bot',
                twitterUserName: this.runtime.getSetting("TWITTER_USERNAME") || '',
                bio: this.runtime.character.bio || '',
                currentPost: memory.content.text || '',
                // Add other necessary context fields
            };

            const response = await generateMessageResponse(
                this.runtime,
                twitterMessageHandlerTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => context[key] || ''),
                ModelClass.Completion
            );

            console.log(`✍️ Generated response: ${response}`);
            return response;
        } catch (error) {
            console.error("❌ Error generating response:", error);
            console.error("Error details:", {
                message: error.message,
                stack: error.stack
            });
            return null;
        }
    }

    private async sendTweetResponse(response: string, replyToId: string): Promise<void> {
        try {
            console.log(`🐦 Sending tweet response to ${replyToId}`);
            // Validate inputs
            if (!response || !response.trim()) {
                console.error("❌ Cannot send empty tweet response");
                return;
            }

            if (!replyToId) {
                console.error("❌ Missing replyToId for tweet response");
                return;
            }

            // Create content object
            const content: Content = {
                text: response,
                source: "twitter"
            };

            // Get room ID from the conversation
            const roomId = stringToUuid(replyToId + "-" + this.runtime.agentId);
            
            // Get Twitter username
            const twitterUsername = this.runtime.getSetting("TWITTER_USERNAME");
            
            const result = await sendTweet(
                this,  // passing the client
                content,
                roomId,
                twitterUsername,
                replyToId
            );
            
            console.log(`✅ Tweet sent successfully:`, result);
            await wait(2000);
        } catch (error) {
            console.error("❌ Error sending tweet:", error);
            console.error("Error details:", {
                message: error.message,
                stack: error.stack
            });
        }
    }
}
