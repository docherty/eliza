import { embeddingZeroVector } from "@ai16z/eliza/src/memory.ts";
import {
    Content,
    IAgentRuntime,
    IImageDescriptionService,
    Memory,
    State,
    UUID,
} from "@ai16z/eliza";
import {
    QueryTweetsResponse,
    Scraper,
    SearchMode,
    Tweet,
} from "agent-twitter-client";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

import { glob } from "glob";

import { elizaLogger } from "@ai16z/eliza/src/logger.ts";
import { stringToUuid } from "@ai16z/eliza/src/uuid.ts";

// Add this class definition before the ClientBase class

class RequestQueue {
    private queue: Array<() => Promise<any>> = [];
    private processing: boolean = false;
    private readonly delay: number = 1000; // 1 second delay between requests

    async add<T>(request: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await request();
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
            this.process();
        });
    }

    private async process(): Promise<void> {
        if (this.processing || this.queue.length === 0) return;

        this.processing = true;
        while (this.queue.length > 0) {
            const request = this.queue.shift();
            if (request) {
                try {
                    await request();
                } catch (error) {
                    console.error('Error processing request:', error);
                }
                // Add delay between requests to respect rate limits
                await new Promise(resolve => setTimeout(resolve, this.delay));
            }
        }
        this.processing = false;
    }
}

export interface IClientBase {
    runtime: IAgentRuntime;
    twitterClient: Scraper;
    // ... other required properties
}

export class ClientBase extends EventEmitter implements IClientBase {
    private static instance: ClientBase;
    private isInitializing = false;
    static _twitterClient: Scraper;
    twitterClient: Scraper;
    runtime: IAgentRuntime;
    directions: string;
    lastCheckedTweetId: number | null = null;
    private baseDir = dirname(fileURLToPath(import.meta.url));
    tweetCacheFilePath = path.join(this.baseDir, "tweetcache/latest_checked_tweet_id.txt");
    imageDescriptionService: IImageDescriptionService;
    temperature: number = 0.5;

    private tweetCache: Map<string, Tweet> = new Map();
    requestQueue: RequestQueue = new RequestQueue();
    twitterUserId: string;

    async cacheTweet(tweet: Tweet): Promise<void> {
        if (!tweet) {
            console.warn("Tweet is undefined, skipping cache");
            return;
        }
        const cacheDir = path.join(
            this.baseDir,
            "tweetcache",
            tweet.conversationId,
            `${tweet.id}.json`
        );
        await fs.promises.mkdir(path.dirname(cacheDir), { recursive: true });
        await fs.promises.writeFile(cacheDir, JSON.stringify(tweet, null, 2));
        this.tweetCache.set(tweet.id, tweet);
    }

    async getCachedTweet(tweetId: string): Promise<Tweet | undefined> {
        if (this.tweetCache.has(tweetId)) {
            return this.tweetCache.get(tweetId);
        }

        const cacheFile = path.join(
            this.baseDir,
            "tweetcache",
            "*",
            `${tweetId}.json`
        );
        const files = await glob(cacheFile);
        if (files.length > 0) {
            const tweetData = await fs.promises.readFile(files[0], "utf-8");
            const tweet = JSON.parse(tweetData) as Tweet;
            this.tweetCache.set(tweet.id, tweet);
            return tweet;
        }

        return undefined;
    }

    async getTweet(tweetId: string): Promise<Tweet> {
        const cachedTweet = await this.getCachedTweet(tweetId);
        if (cachedTweet) {
            return cachedTweet;
        }

        const tweet = await this.requestQueue.add(() =>
            this.twitterClient.getTweet(tweetId)
        );
        await this.cacheTweet(tweet);
        return tweet;
    }

    protected onReady(): void {
        // Remove the console.log and make this a no-op base method
    }

    // Modify the constructor to be protected instead of private
    protected constructor({ runtime }: { runtime: IAgentRuntime }) {
        super();
        
        // Check instance-specific initialization
        if (this.isInitializing) {
            console.log(`[${this.constructor.name}] Already initializing, skipping`);
            return;
        }
        this.isInitializing = true;

        console.log(`[${this.constructor.name}] Starting initialization...`);
        this.runtime = runtime;
        if (ClientBase._twitterClient) {
            this.twitterClient = ClientBase._twitterClient;
        } else {
            this.twitterClient = new Scraper();
            ClientBase._twitterClient = this.twitterClient;
        }

        this.directions =
            "- " +
            this.runtime.character.style.all.join("\n- ") +
            "- " +
            this.runtime.character.style.post.join();

        try {
            console.log("this.tweetCacheFilePath", this.tweetCacheFilePath);
            if (fs.existsSync(this.tweetCacheFilePath)) {
                // make it?
                const data = fs.readFileSync(this.tweetCacheFilePath, "utf-8");
                this.lastCheckedTweetId = parseInt(data.trim());
            } else {
                console.warn("Tweet cache file not found.");
                console.warn(this.tweetCacheFilePath);
            }
        } catch (error) {
            console.error(
                "Error loading latest checked tweet ID from file:",
                error
            );
        }
        const cookiesFilePath = path.join(
            this.baseDir,
            "tweetcache/" +
                this.runtime.getSetting("TWITTER_USERNAME") +
                "_cookies.json"
        );

        const dir = path.dirname(cookiesFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // async initialization
        (async () => {
            try {
                console.log(`[${this.constructor.name}] Starting async initialization...`);
                
                // Check for Twitter cookies
                if (this.runtime.getSetting("TWITTER_COOKIES")) {
                    const cookiesArray = JSON.parse(
                        this.runtime.getSetting("TWITTER_COOKIES")
                    );
                    await this.setCookiesFromArray(cookiesArray);
                } else {
                    console.log("Cookies file path:", cookiesFilePath);
                    if (fs.existsSync(cookiesFilePath)) {
                        const cookiesArray = JSON.parse(
                            fs.readFileSync(cookiesFilePath, "utf-8")
                        );
                        await this.setCookiesFromArray(cookiesArray);
                    } else {
                        await this.twitterClient.login(
                            this.runtime.getSetting("TWITTER_USERNAME"),
                            this.runtime.getSetting("TWITTER_PASSWORD"),
                            this.runtime.getSetting("TWITTER_EMAIL"),
                            this.runtime.getSetting("TWITTER_2FA_SECRET")
                        );
                        console.log("Logged in to Twitter");
                        const cookies = await this.twitterClient.getCookies();
                        fs.writeFileSync(
                            cookiesFilePath,
                            JSON.stringify(cookies),
                            "utf-8"
                        );
                    }
                }

                let loggedInWaits = 0;

                while (!(await this.twitterClient.isLoggedIn())) {
                    console.log(`[${this.constructor.name}] Waiting for Twitter login...`);
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    if (loggedInWaits > 10) {
                        console.error("Failed to login to Twitter");
                        await this.twitterClient.login(
                            this.runtime.getSetting("TWITTER_USERNAME"),
                            this.runtime.getSetting("TWITTER_PASSWORD"),
                            this.runtime.getSetting("TWITTER_EMAIL"),
                            this.runtime.getSetting("TWITTER_2FA_SECRET")
                        );

                        const cookies = await this.twitterClient.getCookies();
                        fs.writeFileSync(
                            cookiesFilePath,
                            JSON.stringify(cookies),
                            "utf-8"
                        );
                        loggedInWaits = 0;
                    }
                    loggedInWaits++;
                }
                const userId = await this.requestQueue.add(async () => {
                    console.log(`[${this.constructor.name}] Getting user ID...`);
                    // wait 3 seconds before getting the user id
                    await new Promise((resolve) => setTimeout(resolve, 10000));
                    try {
                        return await this.twitterClient.getUserIdByScreenName(
                            this.runtime.getSetting("TWITTER_USERNAME")
                        );
                    } catch (error) {
                        console.error("Error getting user ID:", error);
                        return null;
                    }
                });
                if (!userId) {
                    console.error(`[${this.constructor.name}] Failed to get user ID`);
                    return;
                }
                console.log(`[${this.constructor.name}] Got user ID:`, userId);
                this.twitterUserId = userId;

                await this.populateTimeline();
                console.log(`[${this.constructor.name}] Timeline populated, calling onReady...`);
                
                this.onReady();
                console.log(`[${this.constructor.name}] onReady called`);
                
                // Reset initialization flag after completion
                this.isInitializing = false;
            } catch (error) {
                console.error(`[${this.constructor.name}] Error during async initialization:`, error);
                this.isInitializing = false;
            }
        })();
    }

    // Modify getInstance to create the correct subclass instance
    public static getInstance(config: { runtime: IAgentRuntime }): ClientBase {
        if (!ClientBase.instance) {
            // This should be called from a subclass
            throw new Error("getInstance must be called from a subclass");
        }
        return ClientBase.instance;
    }

    async fetchHomeTimeline(count: number): Promise<Tweet[]> {
        const homeTimeline = await this.twitterClient.fetchHomeTimeline(
            count,
            []
        );

        return homeTimeline
            .filter((t) => {
                // Filter out invalid tweets and TweetWithVisibilityResults
                return t && 
                       t.__typename !== "TweetWithVisibilityResults" &&
                       (t.text || t.legacy?.full_text) &&  // Ensure there's text content
                       (t.name || t.core?.user_results?.result?.legacy?.name) && // Ensure there's a name
                       (t.username || t.core?.user_results?.result?.legacy?.screen_name); // Ensure there's a username
            })
            .map((tweet) => {
                const text = tweet.text ?? tweet.legacy?.full_text ?? "";
                const name = tweet.name ?? tweet.core?.user_results?.result?.legacy?.name ?? "Unknown User";
                const username = tweet.username ?? tweet.core?.user_results?.result?.legacy?.screen_name ?? "unknown";
                
                return {
                    id: tweet.rest_id ?? `temp-${Date.now()}`,
                    name,
                    username,
                    text,
                    inReplyToStatusId: tweet.inReplyToStatusId ?? tweet.legacy?.in_reply_to_status_id_str ?? null,
                    createdAt: tweet.createdAt ?? tweet.legacy?.created_at ?? new Date().toISOString(),
                    userId: tweet.userId ?? tweet.legacy?.user_id_str ?? "unknown",
                    conversationId: tweet.conversationId ?? tweet.legacy?.conversation_id_str ?? tweet.rest_id ?? `temp-${Date.now()}`,
                    hashtags: tweet.hashtags ?? tweet.legacy?.entities?.hashtags ?? [],
                    mentions: tweet.mentions ?? tweet.legacy?.entities?.user_mentions ?? [],
                    photos: tweet.photos ?? 
                        (tweet.legacy?.entities?.media?.filter(media => media.type === "photo") ?? []),
                    thread: [],
                    urls: tweet.urls ?? tweet.legacy?.entities?.urls ?? [],
                    videos: tweet.videos ?? 
                        (tweet.legacy?.entities?.media?.filter(media => media.type === "video") ?? []),
                    timestamp: Math.floor(Date.now() / 1000), // Add timestamp field
                    permanentUrl: `https://twitter.com/${username}/status/${tweet.rest_id}`,
                };
            });
    }

    async fetchSearchTweets(
        query: string,
        maxTweets: number,
        searchMode: SearchMode,
        cursor?: string
    ): Promise<QueryTweetsResponse> {
        try {
            // Sometimes this fails because we are rate limited. in this case, we just need to return an empty array
            // if we dont get a response in 5 seconds, something is wrong
            const timeoutPromise = new Promise((resolve) =>
                setTimeout(() => resolve({ tweets: [] }), 10000)
            );

            try {
                const result = await this.requestQueue.add(
                    async () =>
                        await Promise.race([
                            this.twitterClient.fetchSearchTweets(
                                query,
                                maxTweets,
                                searchMode,
                                cursor
                            ),
                            timeoutPromise,
                        ])
                );
                return (result ?? { tweets: [] }) as QueryTweetsResponse;
            } catch (error) {
                console.error("Error fetching search tweets:", error);
                return { tweets: [] };
            }
        } catch (error) {
            console.error("Error fetching search tweets:", error);
            return { tweets: [] };
        }
    }

    private async populateTimeline() {
        const cacheFile = "timeline_cache.json";

        // Check if the cache file exists
        if (fs.existsSync(cacheFile)) {
            // Read the cached search results from the file
            const cachedResults = JSON.parse(
                fs.readFileSync(cacheFile, "utf-8")
            );

            // Get the existing memories from the database
            const existingMemories =
                await this.runtime.messageManager.getMemoriesByRoomIds({
                    agentId: this.runtime.agentId,
                    roomIds: cachedResults.map((tweet) =>
                        stringToUuid(
                            tweet.conversationId + "-" + this.runtime.agentId
                        )
                    ),
                });

            // Create a Set to store the IDs of existing memories
            const existingMemoryIds = new Set(
                existingMemories.map((memory) => memory.id.toString())
            );

            // Check if any of the cached tweets exist in the existing memories
            const someCachedTweetsExist = cachedResults.some((tweet) =>
                existingMemoryIds.has(tweet.id)
            );

            if (someCachedTweetsExist) {
                // Filter out the cached tweets that already exist in the database
                const tweetsToSave = cachedResults.filter(
                    (tweet) => !existingMemoryIds.has(tweet.id)
                );

                // Save the missing tweets as memories
                for (const tweet of tweetsToSave) {
                    const roomId = stringToUuid(
                        tweet.conversationId ??
                            "default-room-" + this.runtime.agentId
                    );
                    const tweetuserId =
                        tweet.userId === this.twitterUserId
                            ? this.runtime.agentId
                            : stringToUuid(tweet.userId);

                    await this.runtime.ensureConnection(
                        tweetuserId,
                        roomId,
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );

                    const content = {
                        text: tweet.text,
                        url: tweet.permanentUrl,
                        source: "twitter",
                        inReplyTo: tweet.inReplyToStatusId
                            ? stringToUuid(
                                  tweet.inReplyToStatusId +
                                      "-" +
                                      this.runtime.agentId
                              )
                            : undefined,
                    } as Content;

                    elizaLogger.log("Creating memory for tweet", tweet.id);

                    // check if it already exists
                    const memory =
                        await this.runtime.messageManager.getMemoryById(
                            stringToUuid(tweet.id + "-" + this.runtime.agentId)
                        );
                    if (memory) {
                        elizaLogger.log(
                            "Memory already exists, skipping timeline population"
                        );
                        break;
                    }

                    await this.runtime.messageManager.createMemory({
                        id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                        userId: tweetuserId,
                        content: content,
                        agentId: this.runtime.agentId,
                        roomId,
                        embedding: embeddingZeroVector,
                        createdAt: tweet.timestamp * 1000,
                    });
                }

                elizaLogger.log(
                    `Populated ${tweetsToSave.length} missing tweets from the cache.`
                );
                return;
            }
        }

        // Get the most recent 20 mentions and interactions
        const mentionsAndInteractions = await this.fetchSearchTweets(
            `@${this.runtime.getSetting("TWITTER_USERNAME")}`,
            20,
            SearchMode.Latest
        );

        // Combine the timeline tweets and mentions/interactions
        const allTweets = [...mentionsAndInteractions.tweets];

        // Create a Set to store unique tweet IDs
        const tweetIdsToCheck = new Set<string>();

        // Add tweet IDs to the Set
        for (const tweet of allTweets) {
            tweetIdsToCheck.add(tweet.id);
        }

        // Convert the Set to an array of UUIDs
        const tweetUuids = Array.from(tweetIdsToCheck).map((id) =>
            stringToUuid(id + "-" + this.runtime.agentId)
        );

        // Check the existing memories in the database
        const existingMemories =
            await this.runtime.messageManager.getMemoriesByRoomIds({
                agentId: this.runtime.agentId,
                roomIds: tweetUuids,
            });

        // Create a Set to store the existing memory IDs
        const existingMemoryIds = new Set<UUID>(
            existingMemories.map((memory) => memory.roomId)
        );

        // Filter out the tweets that already exist in the database
        const tweetsToSave = allTweets.filter(
            (tweet) =>
                !existingMemoryIds.has(
                    stringToUuid(tweet.id + "-" + this.runtime.agentId)
                )
        );

        await this.runtime.ensureUserExists(
            this.runtime.agentId,
            this.runtime.getSetting("TWITTER_USERNAME"),
            this.runtime.character.name,
            "twitter"
        );

        // Save the new tweets as memories
        for (const tweet of tweetsToSave) {
            const roomId = stringToUuid(
                tweet.conversationId ?? "default-room-" + this.runtime.agentId
            );
            const tweetuserId =
                tweet.userId === this.twitterUserId
                    ? this.runtime.agentId
                    : stringToUuid(tweet.userId);

            await this.runtime.ensureConnection(
                tweetuserId,
                roomId,
                tweet.username,
                tweet.name,
                "twitter"
            );

            const content = {
                text: tweet.text,
                url: tweet.permanentUrl,
                source: "twitter",
                inReplyTo: tweet.inReplyToStatusId
                    ? stringToUuid(tweet.inReplyToStatusId)
                    : undefined,
            } as Content;

            await this.runtime.messageManager.createMemory({
                id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                userId: tweetuserId,
                content: content,
                agentId: this.runtime.agentId,
                roomId,
                embedding: embeddingZeroVector,
                createdAt: tweet.timestamp * 1000,
            });
        }

        // Cache the search results to the file
        fs.writeFileSync(cacheFile, JSON.stringify(allTweets));
    }

    async setCookiesFromArray(cookiesArray: any[]) {
        const cookieStrings = cookiesArray.map(
            (cookie) =>
                `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${
                    cookie.secure ? "Secure" : ""
                }; ${cookie.httpOnly ? "HttpOnly" : ""}; SameSite=${
                    cookie.sameSite || "Lax"
                }`
        );
        await this.twitterClient.setCookies(cookieStrings);
    }

    async saveRequestMessage(message: Memory, state: State) {
        if (message.content.text) {
            const recentMessage = await this.runtime.messageManager.getMemories(
                {
                    roomId: message.roomId,
                    agentId: this.runtime.agentId,
                    count: 1,
                    unique: false,
                }
            );

            if (
                recentMessage.length > 0 &&
                recentMessage[0].content === message.content
            ) {
                console.log("Message already saved", recentMessage[0].id);
            } else {
                await this.runtime.messageManager.createMemory({
                    ...message,
                    embedding: embeddingZeroVector,
                });
            }

            await this.runtime.evaluate(message, {
                ...state,
                twitterClient: this.twitterClient,
            });
        }
    }
}
