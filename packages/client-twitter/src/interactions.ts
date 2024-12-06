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
    State as ElizaState,
} from "@ai16z/eliza/src/types.ts";
import { stringToUuid } from "@ai16z/eliza/src/uuid.ts";
import { ClientBase } from "./base.ts";
import {
    buildConversationThread,
    calculateMinutesAgo,
    num,
    sendTweet,
    wait,
} from "./utils.ts";
import { getActorDetails, formatMessages } from "@ai16z/eliza/src/messages.ts";
import { embeddingZeroVector } from "@ai16z/eliza/src/memory.ts";
import elizaLogger from "@ai16z/eliza/src/logger.ts";

export const twitterMessageHandlerTemplate =
    `
About {{twitterKnownName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}

{{characterPostExamples}}

{{replyDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

{{twitterReplyTask}}

Current post: {{currentPost}}

` + messageCompletionFooter;

export const twitterShouldRespondTemplate =
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

{{agentName}} should respond to messages that are directed at them, or participate in conversations that are interesting or relevant to their background, IGNORE messages that are irrelevant to them, and should STOP if the conversation is concluded.

{{agentName}} is in a room with other users and wants to be conversational, but not annoying.
{{agentName}} should RESPOND to messages that are directed at them, or participate in conversations that are interesting or relevant to their background.
If a message is not interesting or relevant, {{agentName}} should IGNORE.
Unless directly RESPONDing to a user, {{agentName}} should IGNORE messages that are very short or do not contain much information.
If a user asks {{agentName}} to stop talking, {{agentName}} should STOP.
If {{agentName}} concludes a conversation and isn't part of the conversation anymore, {{agentName}} should STOP.

{{recentPosts}}

IMPORTANT: {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.

{{currentPost}}

Thread of Tweets You Are Replying To:

{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

interface TwitterState {
    recentMessages?: Memory[];
}

export class TwitterInteractionClient extends ClientBase {
    onReady() {
        const handleTwitterInteractionsLoop = () => {
            this.handleTwitterInteractions();
            const delayMins = num(
                this.runtime.getSetting("checkIntervals.minMinutes") || 1,
                this.runtime.getSetting("checkIntervals.maxMinutes") || 2
            );
            const nextCheck = new Date(Date.now() + delayMins * 60 * 1000);
            console.log(`Next interactions check at: ${nextCheck.toLocaleString()}`);
            setTimeout(handleTwitterInteractionsLoop, delayMins * 60 * 1000);
        };
        handleTwitterInteractionsLoop();
    }

    constructor(runtime: IAgentRuntime) {
        super({
            runtime,
        });
    }

    async handleTwitterInteractions() {
        console.log("Checking Twitter interactions");
        try {
            // Check for mentions
            const tweetCandidates = (
                await this.fetchSearchTweets(
                    `@${this.runtime.getSetting("TWITTER_USERNAME")}`,
                    5,
                    SearchMode.Latest
                )
            ).tweets;

            // for (const tweet of tweetCandidates) {
            //     console.log(tweet);
            //     console.log("minAgo = ", calculateMinutesAgo(tweet.timestamp));
            // }
            // console.log("tweetCandidates", tweetCandidates);
            // return;

            // de-duplicate tweetCandidates with a set
            const uniqueTweetCandidates = [...new Set(tweetCandidates)];

            // Sort tweet candidates by ID in ascending order
            uniqueTweetCandidates
                .sort((a, b) => a.id.localeCompare(b.id))
                .filter((tweet) => tweet.userId !== this.twitterUserId);

            // for each tweet candidate, handle the tweet
            for (const tweet of uniqueTweetCandidates) {
                if (!this.lastCheckedTweetId || parseInt(tweet.id) > this.lastCheckedTweetId) {
                    try {
                        const conversationId = tweet.conversationId + "-" + this.runtime.agentId;
                        const roomId = stringToUuid(conversationId);
                        const userIdUUID = stringToUuid(tweet.userId as string);

                        await this.runtime.ensureConnection(
                            userIdUUID,
                            roomId,
                            tweet.username,
                            tweet.name,
                            "twitter"
                        );

                        const thread = await buildConversationThread(tweet, this);
                        // if thread.length > 0 i don't want to send any more tweets. I need to ensure that the is marked as handled but silently without sending a tweet.
                        if (thread.length > 9) {
                            elizaLogger.debug("Thread is too long, skipping tweet", {
                                tweetId: tweet.id,
                                threadLength: thread.length
                            });
                            // mark the tweet as handled
                            this.lastCheckedTweetId = parseInt(tweet.id);
                            await this.saveTweetCheckpoint();
                            continue;
                        }
                            
                        console.log("thread", thread);

                        const message = {
                            content: { 
                                text: tweet.text || "",
                                action: "",
                            },
                            agentId: this.runtime.agentId,
                            userId: userIdUUID,
                            roomId,
                            recentMessages: await this.runtime.messageManager.getMemories({ 
                                roomId,
                                count: 10
                            }) || [],
                            participants: [{
                                userId: this.runtime.agentId,
                                name: this.runtime.character.name,
                                username: this.runtime.getSetting("TWITTER_USERNAME"),
                                platform: "twitter"
                            }],
                            currentParticipant: {
                                userId: this.runtime.agentId,
                                name: this.runtime.character.name,
                                username: this.runtime.getSetting("TWITTER_USERNAME"),
                                platform: "twitter"
                            }
                        };

                        await this.handleTweet({ tweet, message, thread });
                        
                        // Only update lastCheckedTweetId if handleTweet completes successfully
                        this.lastCheckedTweetId = parseInt(tweet.id);
                        await this.saveTweetCheckpoint();
                    } catch (error) {
                        console.error(`Error processing tweet ${tweet.id}:`, error);
                        // Don't update lastCheckedTweetId on error
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

            console.log(`Finished checking Twitter interactions at ${new Date().toLocaleString()}`);
        } catch (error) {
            console.error("Error handling Twitter interactions:", error);
        }
    }

    private async handleTweet({
        tweet,
        message,
        thread
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
    }) {
        try {
            if (tweet.username === this.runtime.getSetting("TWITTER_USERNAME")) {
                console.log("skipping tweet from bot itself", tweet.id);
                return;
            }
    
            // Get recent messages and process them
            const recentMessages = (await this.runtime.messageManager.getMemories({ 
                roomId: message.roomId,
                count: 10
            }) || []).filter(msg => msg && typeof msg === 'object').map(msg => ({
                id: msg.id,
                roomId: msg.roomId,
                userId: msg.userId,
                agentId: msg.agentId,
                content: {
                    text: msg.content?.text || "",
                    action: msg.content?.action || "",
                    url: msg.content?.url || "",
                    inReplyTo: msg.content?.inReplyTo,
                    source: "twitter"
                },
                createdAt: msg.createdAt || Date.now(),
                embedding: msg.embedding || embeddingZeroVector
            }));
    
            const actors = await getActorDetails({
                runtime: this.runtime,
                roomId: message.roomId
            });
    
            const recentPostInteractions = formatMessages({
                messages: recentMessages,
                actors: actors
            });
    
            const baseParticipant = {
                userId: this.runtime.agentId,
                name: this.runtime.character.name,
                username: this.runtime.getSetting("TWITTER_USERNAME"),
                platform: "twitter"
            };
    
            const safeMessage = {
                id: message.id,
                roomId: message.roomId,
                userId: message.userId,
                agentId: message.agentId,
                content: {
                    text: message.content?.text || "",
                    action: message.content?.action || "",
                    url: message.content?.url || "",
                    inReplyTo: message.content?.inReplyTo,
                    source: "twitter"
                },
                recentMessages,
                participants: [baseParticipant],
                currentParticipant: baseParticipant,
                createdAt: message.createdAt || Date.now(),
                embedding: message.embedding || embeddingZeroVector
            };
    
            if (!safeMessage.content.text) {
                console.log("skipping tweet with no text", tweet.id);
                return { text: "", action: "IGNORE" };
            }
    
            console.log("handling tweet", tweet.id);
            const formatTweet = (tweet: Tweet) => {
                return `  ID: ${tweet.id || ""}
      From: ${tweet.name || ""} (@${tweet.username || ""})
      Text: ${tweet.text || ""}`;
            };
            const currentPost = formatTweet(tweet);
    
            let homeTimeline = [];
            if (fs.existsSync("tweetcache/home_timeline.json")) {
                homeTimeline = JSON.parse(
                    fs.readFileSync("tweetcache/home_timeline.json", "utf-8")
                );
            } else {
                homeTimeline = await this.fetchHomeTimeline(50);
                if (!fs.existsSync("tweetcache")) {
                    fs.mkdirSync("tweetcache", { recursive: true });
                }
                fs.writeFileSync(
                    "tweetcache/home_timeline.json",
                    JSON.stringify(homeTimeline, null, 2)
                );
            }
    
            console.log("Thread: ", thread);
            const formattedConversation = thread
                .map(tweet => `@${tweet.username} (${new Date(tweet.timestamp * 1000).toLocaleString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    month: 'short',
                    day: 'numeric'
                })}):
            ${tweet.text}`)
                .join('\n\n');
            
            console.log("formattedConversation: ", formattedConversation);

            const formattedHomeTimeline =
                `# ${this.runtime.character.name}'s Home Timeline\n\n` +
                homeTimeline
                    .map((tweet) => {
                        return `ID: ${tweet.id || ""}\nFrom: ${tweet.name || ""} (@${tweet.username || ""})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}\nText: ${tweet.text || ""}\n---\n`;
                    })
                    .join("\n");
    
            let state = await this.runtime.composeState(safeMessage, {
                twitterClient: this.twitterClient,
                twitterUserName: this.runtime.getSetting("TWITTER_USERNAME"),
                twitterKnownName: this.runtime.getSetting("TWITTER_KNOWNNAME"),
                twitterReplyTask: this.runtime.character.templates?.twitterReplyTask || "Default post task",
                currentPost,
                formattedConversation,
                timeline: formattedHomeTimeline,
                replyDirections: Array.isArray(this.runtime.character?.style?.chat) ? 
                    this.runtime.character.style.chat.join("\n") : 
                    "write replys that are warm and engaging",  // Default fallback from naval.json
                recentPostInteractions,
                participants: [baseParticipant],
                recentMessages,
                actorsData: [baseParticipant]
            });
    
            // Rest of the function remains the same...
            const shouldRespondContext = composeContext({
                state,
                template:
                    this.runtime.character.templates?.twitterShouldRespondTemplate ||
                    this.runtime.character?.templates?.shouldRespondTemplate ||
                    twitterShouldRespondTemplate,
            });
    
            console.log("composeContext done");

            const shouldRespond = await generateShouldRespond({
                runtime: this.runtime,
                context: shouldRespondContext,
                modelClass: ModelClass.SMALL,
            });
    
            if (!shouldRespond) {
                console.log("Not responding to message");
                return { text: "", action: "IGNORE" };
            }
    
            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.twitterMessageHandlerTemplate ||
                    this.runtime.character?.templates?.messageHandlerTemplate ||
                    twitterMessageHandlerTemplate,
            });
    
            // Add debug logging for context
            console.log('=== Debug: Interaction Template Content Snippets ===');
            const contextLines = context.split('\n');
            contextLines.forEach((line, index) => {
                if (line.trim()) {
                    console.log(`Line ${index + 1}: ${line.slice(0, 100)}${line.length > 100 ? '...' : ''}`);
                }
            });
    
            const response = await generateMessageResponse({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });
    
            console.log('=== Debug: Generated Reply Content ===');
            console.log(response.text);
            console.log('================================');
    
            const stringId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
            response.inReplyTo = stringId;
    
            if (response.text) {
                try {
                    const callback: HandlerCallback = async (response: Content) => {
                        try {
                            const memories = await sendTweet(
                                this,
                                response,
                                safeMessage.roomId,
                                this.runtime.getSetting("TWITTER_USERNAME"),
                                tweet.id
                            );
                            return memories;
                        } catch (error) {
                            // Handle Twitter API errors
                            if (error.message?.includes('Twitter API error')) {
                                const errorCode = error.message.match(/Code: (\d+)/)?.[1];
                                if (errorCode === '187') {
                                    console.log("Skipping duplicate reply tweet");
                                    return []; // Return empty memories array for duplicate tweets
                                }
                            }
                            throw error; // Re-throw other errors
                        }
                    };

                    const responseMessages = await callback(response);
                    if (responseMessages.length === 0) {
                        console.log("No messages to process (possibly due to duplicate tweet)");
                        return;
                    }

                    state = (await this.runtime.updateRecentMessageState(state)) as ElizaState;
    
                    for (const responseMessage of responseMessages) {
                        await this.runtime.messageManager.createMemory(responseMessage);
                    }
    
                    await this.runtime.evaluate(safeMessage, state, true);
                    await this.runtime.processActions(safeMessage, responseMessages, state);
                    
                    const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;
                    
                    if (!fs.existsSync("tweets")) {
                        fs.mkdirSync("tweets");
                    }
                    const debugFileName = `tweets/tweet_generation_${tweet.id}.txt`;
                    fs.writeFileSync(debugFileName, responseInfo);
                    await wait();
                } catch (error) {
                    console.error(`Error sending response tweet: ${error}`);
                    if (error.message?.includes('duplicate') || error.message?.includes('Code: 187')) {
                        console.log("Skipping duplicate tweet interaction");
                        return;
                    }
                    throw error;
                }
            }
        } catch (error) {
            if (error.name === 'AI_RetryError') {
                console.log(`API overloaded, skipping tweet ${tweet.id} for now. Will retry on next poll.`);
                return;
            }
            // Add check for duplicate tweets at this level too
            if (error.message?.includes('duplicate') || error.message?.includes('Code: 187')) {
                console.log("Skipping duplicate tweet at interaction level");
                return;
            }
            throw error;
        }
    }

    private async saveTweetCheckpoint() {
        try {
            if (this.lastCheckedTweetId) {
                fs.writeFileSync(
                    this.tweetCacheFilePath,
                    this.lastCheckedTweetId.toString(),
                    "utf-8"
                );
            }
        } catch (error) {
            console.error("Error saving tweet checkpoint:", error);
        }
    }
}
