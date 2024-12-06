import { Tweet } from "agent-twitter-client";
import fs from "fs";
import { composeContext } from "@ai16z/eliza/src/context.ts";
import { generateText } from "@ai16z/eliza/src/generation.ts";
import { embeddingZeroVector } from "@ai16z/eliza/src/memory.ts";
import { IAgentRuntime, ModelClass } from "@ai16z/eliza/src/types.ts";
import { stringToUuid } from "@ai16z/eliza/src/uuid.ts";
import { ClientBase } from "./base.ts";
import { num } from "./utils.ts";

const twitterPostTemplate = `
# About {{twitterKnownName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}

# Example posts:
{{characterPostExamples}}

# TASK:
styleSelection: {{styleSelection}}
themeSelection: {{themeSelection}}

{{twitterPostTask}}`

// Add type guard
interface SafeMessage {
    userId: `${string}-${string}-${string}-${string}-${string}`;
    roomId: `${string}-${string}-${string}-${string}-${string}`;
    agentId: `${string}-${string}-${string}-${string}-${string}`;
    content: {
        text: string;
        action: string;
        url: string;
        inReplyTo?: `${string}-${string}-${string}-${string}-${string}`;
    };
    recentMessages: any[];
    participants: Array<{
        userId: string;
        name: string;
        username: string;
        platform: string;
    }>;
    currentParticipant: {
        userId: string;
        name: string;
        username: string;
        platform: string;
    };
}

// Validation function
function validateState(state: any): state is SafeMessage {
    return (
        state &&
        typeof state.userId === 'string' &&
        typeof state.roomId === 'string' &&
        typeof state.agentId === 'string' &&
        state.content &&
        typeof state.content.text === 'string' &&
        typeof state.content.action === 'string' &&
        typeof state.content.url === 'string' &&
        Array.isArray(state.recentMessages) &&
        Array.isArray(state.participants) &&
        state.currentParticipant
    );
}

export class TwitterPostClient extends ClientBase {
    onReady() {
        // console.log(`Starting tweet generation loop at ${new Date().toLocaleString()}`);
        const generateNewTweetLoop = () => {
            const postIntervals = this.runtime.getSetting("postIntervals") as any;
            const delayMins = num(
                postIntervals?.minMinutes || 180,
                postIntervals?.maxMinutes || 480
            );
            const nextPost = new Date(Date.now() + delayMins * 60 * 1000);
            console.log(`Next tweet will be in ${delayMins} mins at: ${nextPost.toLocaleString()}`);
            
            setTimeout(() => {
                this.generateNewTweet();
                generateNewTweetLoop();
            }, delayMins * 60 * 1000);
        };
        generateNewTweetLoop();
    }

    constructor(runtime: IAgentRuntime) {
        // Initialize the client and pass an optional callback to be called when the client is ready
        super({
            runtime,
        });
    }

    private async generateNewTweet() {
        console.log("\n=== Starting New Tweet Generation ===");
        console.log(`Agent: ${this.runtime.character?.name} (@${this.runtime.getSetting("TWITTER_USERNAME")})`);

        try {
            // fetch the styleLibrary
            const styleLibrary = this.runtime.character?.postConfig?.styles || [];
            const themeLibrary = this.runtime.character?.postConfig?.themes || [];

            // get a random style from the styleLibrary
            let styleSelection = styleLibrary[Math.floor(Math.random() * styleLibrary.length)];
            // get a random theme from the themeLibrary
            let themeSelection = themeLibrary[Math.floor(Math.random() * themeLibrary.length)];
            
            // check if styleSelection is a valid string, if not, set it to a fallback
            if (typeof styleSelection !== 'string') {
                console.log("WARNING: Invalid styleSelection, using fallback value");
                styleSelection = "Direct inquiry about missing innovation or system improvement (40-90 chars)";
            }
            // check if themeSelection is a valid string, if not, set it to a fallback
            if (typeof themeSelection !== 'string') {
                themeSelection = "Technical architecture, platforms, products, and innovations";
            }

           // console.log(`Selected style: ${styleSelection}`);
           // console.log(`Selected theme: ${themeSelection}`);

            // Get all room IDs for this agent's conversations
            const rooms = await this.runtime.databaseAdapter.getRoomsForParticipant(this.runtime.agentId);
            //console.log("Found rooms:", rooms.length);

            const allMemories = await this.runtime.messageManager.getMemoriesByRoomIds({
                agentId: this.runtime.agentId,
                roomIds: rooms // Pass all room IDs
            });

            // console.log("\n=== Debug: Memory Query ===");
            // console.log("Total memories found:", allMemories.length);

            // Filter tweets using the same pattern as buildConversationThread
            const standaloneTweets = allMemories.filter(memory => 
                memory.content.source === 'twitter' && 
                !memory.content.inReplyTo && 
                memory.userId === this.runtime.agentId &&
                memory.agentId === this.runtime.agentId // Additional check to match buildConversationThread
            );

           // console.log(`Found ${standaloneTweets.length} previous tweets`);

            // Sort by date, most recent first
            const recentTweets = standaloneTweets
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
                .slice(0, 10);

         //   console.log("\n=== Agent's Recent Standalone Tweets ===");
         //   console.log("Number of tweets found:", recentTweets.length);
         //   recentTweets.forEach((tweet, index) => {
         //       console.log(`\nTweet ${index + 1}:`);
         //       console.log('Created:', new Date(tweet.createdAt || 0).toLocaleString());
         //       console.log('Text:', tweet.content.text);
         //       console.log('URL:', tweet.content.url);
         //       console.log('Is Reply:', !!tweet.content.inReplyTo);
         //   });

            // Format tweets for the template
            const formattedOwnTweets = recentTweets
                .map(tweet => {
                    // Preserve line breaks by using a single string
                    return `Tweet: ${tweet.content.text.replace(/\n/g, '\\n')}\nPosted: ${new Date(tweet.createdAt || 0).toLocaleString()}\n---`;
                })
                .join("\n");

        //   console.log('\n=== Debug: Formatted Own Tweets ===');
        //   console.log('Number of formatted tweets:', recentTweets.length);
        //   console.log('First 500 characters of formatted tweets:', formattedOwnTweets.slice(0, 500));

            // Create the state with the agent's tweets
            const baseParticipant = {
                userId: this.runtime.agentId,
                name: this.runtime.character.name,
                username: this.runtime.getSetting("TWITTER_USERNAME"),
                platform: "twitter"
            };

            const roomId = stringToUuid("twitter_generate_room");
            
            const safeState = {
                id: stringToUuid(`generate-${Date.now()}`),
                userId: this.runtime.agentId,
                roomId,
                agentId: this.runtime.agentId,
                content: {
                    text: "Starting new tweet generation",
                    action: "generate_tweet",
                    url: "",
                    inReplyTo: undefined,
                    source: "twitter"
                },
                recentPosts: formattedOwnTweets, // Add the formatted tweets here
                participants: [baseParticipant],
                currentParticipant: baseParticipant,
                createdAt: Date.now(),
                embedding: embeddingZeroVector
            };
            
            await this.runtime.ensureRoomExists(roomId);
            await this.runtime.ensureParticipantInRoom(this.runtime.agentId, roomId);
    
            const state = await this.runtime.composeState(safeState, {
                twitterUserName: this.runtime.getSetting("TWITTER_USERNAME"),
                twitterKnownName: this.runtime.getSetting("TWITTER_KNOWNNAME"),
                recentMessages: recentTweets,
                actorsData: [baseParticipant],
                twitterPostTask: this.runtime.character.templates?.twitterPostTask || "Default post task",
                agentName: this.runtime.character?.name || "Unknown Agent",
                bio: Array.isArray(this.runtime.character?.bio) ? this.runtime.character.bio.join("\n") : "",
                lore: Array.isArray(this.runtime.character?.lore) ? this.runtime.character.lore.join("\n") : "",
                postDirections: Array.isArray(this.runtime.character?.style?.post) ? 
                    this.runtime.character.style.post.join("\n") : 
                    "write statements that read like discovered laws",  // Default fallback from naval.json
                styleSelection: styleSelection,
                themeSelection: themeSelection,
                recentPosts: recentTweets.map(tweet => tweet.content.text.replace(/\n/g, '\\n')).join("\n"),
                characterPostExamples: Array.isArray(this.runtime.character?.postExamples) ? 
                    this.runtime.character.postExamples.join("\n") : ""
            });
    
            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.twitterPostTemplate ||
                    twitterPostTemplate,
            });
    
 //          console.log('=== Debug: Template Content Snippets ===');
 //          const contextLines = context.split('\n');
 //          contextLines.forEach((line, index) => {
 //              if (line.trim()) {
 //                  console.log(`Line ${index + 1}: ${line.slice(0, 100)}${line.length > 100 ? '...' : ''}`);
 //              }
 //          });

            const newTweetContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

 //          console.log('=== Debug: Generated Tweet Content ===');
 //          console.log(newTweetContent);
 //          console.log('================================');
    
            const slice = (newTweetContent || "").replaceAll(/\\n/g, "\n").trim();
            const contentLength = 240;
            let content = slice.slice(0, contentLength);
            
            if (content.length > 280) {
                content = content.slice(0, content.lastIndexOf("\n"));
            }
            if (content.length > contentLength) {
                content = content.slice(0, content.lastIndexOf("."));
            }
            if (content.length > contentLength) {
                content = content.slice(0, content.lastIndexOf("."));
            }
    
            try {
                const result = await this.requestQueue.add(
                    async () => await this.twitterClient.sendTweet(content)
                );
                
                const body = await result.json();

                // Check for Twitter API errors first
                if (body.errors) {
                    const error = body.errors[0];
                    if (error.code === 187) {
                        console.log("Skipping duplicate tweet");
                        return; // Exit gracefully for duplicates
                    }
                    throw new Error(`Twitter API error: ${error.message} (Code: ${error.code})`);
                }

                // Validate response structure
                if (!body?.data?.create_tweet?.tweet_results?.result) {
                    console.error('Invalid Twitter API response:', JSON.stringify(body));
                    throw new Error('Invalid Twitter API response structure');
                }

                const tweetResult = body.data.create_tweet.tweet_results.result;
                
                // Additional validation for required fields
                if (!tweetResult.rest_id || !tweetResult.legacy) {
                    throw new Error('Missing required tweet data fields');
                }

                const tweet = {
                    id: tweetResult.rest_id,
                    text: tweetResult.legacy?.full_text || "",
                    conversationId: tweetResult.legacy?.conversation_id_str || tweetResult.rest_id,
                    createdAt: tweetResult.legacy?.created_at || new Date().toISOString(),
                    userId: tweetResult.legacy?.user_id_str || this.runtime.agentId,
                    inReplyToStatusId: tweetResult.legacy?.in_reply_to_status_id_str,
                    permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
                    hashtags: [],
                    mentions: [],
                    photos: [],
                    thread: [],
                    urls: [],
                    videos: [],
                    timestamp: Math.floor(Date.now() / 1000),
                } as Tweet;
    
                const postId = tweet.id;
                const conversationId = tweet.conversationId + "-" + this.runtime.agentId;
                const conversationRoomId = stringToUuid(conversationId);
    
                await this.runtime.ensureRoomExists(conversationRoomId);
                await this.runtime.ensureParticipantInRoom(this.runtime.agentId, conversationRoomId);
                await this.cacheTweet(tweet);
    
                await this.runtime.messageManager.createMemory({
                    id: stringToUuid(postId + "-" + this.runtime.agentId),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: newTweetContent?.trim() || "",
                        url: tweet.permanentUrl,
                        source: "twitter",
                        action: "",
                        inReplyTo: undefined
                    },
                    roomId: conversationRoomId,
                    embedding: embeddingZeroVector,
                    createdAt: tweet.timestamp ? tweet.timestamp * 1000 : Date.now()
                });
    
    //           console.log("\n=== Debug: Tweet Memory Creation ===");
    //           console.log("Creating memory for tweet ID:", postId);
    //           console.log("Room ID:", conversationRoomId);

                // Verify the memory was saved
                const savedMemory = await this.runtime.messageManager.getMemoryById(
                    stringToUuid(postId + "-" + this.runtime.agentId)
                );
     //           console.log("\n=== Debug: Memory Save Verification ===");
     //           console.log("Memory found in database:", !!savedMemory);
                if (savedMemory) {
                    console.log("Memory content:", {
                        id: savedMemory.id,
                        text: savedMemory.content.text,
                        source: savedMemory.content.source,
                        url: savedMemory.content.url
                    });
                }
    
                console.log(`New tweet posted at ${new Date().toLocaleString()} - "${content.slice(0, 50)}${content.length > 50 ? '...' : ''}""`);
                
            } catch (error) {
                console.error("Error generating tweet:", error);
                if (error.message.includes('duplicate')) {
                    // Handle duplicate tweets gracefully
                    return;
                }
                throw error;
            }
        } catch (error) {
            console.error("Tweet generation failed:", error.message);
            throw error;
        }
    }
}