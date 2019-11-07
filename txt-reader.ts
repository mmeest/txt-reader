import { TextDecoder } from 'text-encoding-shim'
import 'promise-polyfill/src/polyfill'
import './polyfill'
import { IRequestMessage, IResponseMessage, IIteratorConfigMessage, LinesRanges, IGetSporadicLinesResult, LinesRange } from './txt-reader-common'
import { TextDecoder_Instance } from 'text-encoding-shim'
import cloneDeep from "lodash.clonedeep"

interface ITaskResponse {
    timeTaken: number;
    message: string;
    result: any;
}

interface ILoadFileTaskResponse extends ITaskResponse {
    result: LoadFileResult;
}

interface ISniffLinesTaskResponse extends ITaskResponse {
    result: (string | Uint8Array)[];
}

interface IGetLinesTaskResponse extends ITaskResponse {
    result: (string | Uint8Array)[];
}

interface IGetLines2TaskResponse extends ITaskResponse {
    result: {
        range: LinesRange | number;
        contents: (string | Uint8Array)[];
    }[]
}

interface IGetSporadicLinesTaskResponse extends ITaskResponse {
    result: IGetSporadicLinesResult[]
}

interface ISetChunkSizeResponse extends ITaskResponse {
    result: number;
}

interface IIterateLinesTaskResponse extends ITaskResponse {
    result: any;
}

type LoadFileResult = {
    lineCount: number;
    scope?: any;
}

interface IResponseMessageEvent extends MessageEvent {
    data: IResponseMessage;
}

interface IIteratorScope {
    [key: string]: any;
}

export interface IIteratorConfig {
    eachLine: (this: IIteratorEachLineThis, raw: Uint8Array, progress: number, lineNumber: number) => void;
    scope?: IIteratorScope;
}

interface IIteratorEachLineThis {
    decode(value: Uint8Array): string;
    [key: string]: any;
}

class RequestMessage implements IRequestMessage {
    // When TxtReader in window context needs ask the worker to do a new task, it needs to send a requestMessage to the worker

    // action to perform
    public action: string;

    // data to post
    public data: any;

    // unique task id, set by TxtReader.newTask method
    public taskId!: number;

    constructor(action: string, data?: any) {
        this.action = action;
        this.data = data !== undefined ? data : null;
    }
}

enum TxtReaderTaskState {
    Initialized,
    Queued,
    Running,
    Completed
}

class TxtReaderTask<T> {
    // All the communications between the Window context and the worker context are based on TxtReaderTask and following conventions
    // 1. Only one task can be running at a time
    // 2. Task is created through TxtReader.newTask method, DO NOT directly create instance of TxtReaderTask
    // 3. TxtReader.newTask method returns an instance of TxtReaderTask
    // 4. TxtReaderTask is async (based on promise)
    // Usage: task.progress(progress=>{}).then(response=>{}).catch(reason=>{})

    // task id, generated by TxtReader.newTaskId method
    public id: number;

    // requestMessage which will be used when window context posts message to the worker context
    public requestMessage: RequestMessage;

    // task state, initialized, queued, running, completed
    public state: TxtReaderTaskState;

    // reference to the TxtReader instance that created this task
    private parser: TxtReader;

    // property to save the onProgress callback function
    private onProgress: Function | null;

    // define the promise object used by the task
    private promise: Promise<any> | null;

    // promise resolve
    private resolve: any;

    // promise reject
    private reject: any;

    // record task startTime
    private startTime: number;

    constructor(id: number, reqMsg: RequestMessage, parser: TxtReader) {
        this.id = id;
        this.requestMessage = reqMsg;
        this.parser = parser;
        this.requestMessage.taskId = id;
        this.state = TxtReaderTaskState.Initialized;
        this.onProgress = null;
        this.startTime = 0;

        // initialize the task promise object, assign the resolve, reject methods.
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }

    private dispose() {
        // release the memory inside promise obejct
        this.resolve = null;
        this.reject = null;
        this.promise = null;
    }

    // run the task, postMessage would be triggered in TxtReader
    // just change the state and record the task start time here
    public run() {
        this.state = TxtReaderTaskState.Running;
        this.startTime = new Date().getTime();
    }

    // be called when a task completes no matter it succeeds or fails
    public complete(response: IResponseMessage) {
        this.state = TxtReaderTaskState.Completed;
        let timeTaken: number = new Date().getTime() - this.startTime;
        if (response.success) {
            let taskResponse: ITaskResponse = {
                timeTaken: timeTaken,
                message: response.message,
                result: response.result
            }
            this.resolve(taskResponse);
        } else {
            this.reject(response.message);
        }
        this.dispose();
    }

    public updateProgress(progress: number) {
        if (this.onProgress !== null) {
            this.onProgress.call(this.parser, progress);
        }
    }

    public then(onFulFilled: (response: T) => void): TxtReaderTask<T> {
        if (this.promise) {
            this.promise.then((data) => {
                onFulFilled.call(this.parser, data);
            }).catch((reason) => { });
        }
        return this;
    }

    public catch(onFailed: (reason: string) => void): TxtReaderTask<T> {
        if (this.promise) {
            this.promise.catch((reason) => {
                onFailed.call(this.parser, reason);
            });
        }
        return this;
    }

    public progress(onProgress: (progress: number) => void): TxtReaderTask<T> {
        this.onProgress = onProgress;
        return this;
    }
}

export class TxtReader {
    private worker: Worker;
    private taskList: TxtReaderTask<any>[];
    private runningTask: TxtReaderTask<any> | null;
    private queuedTaskList: TxtReaderTask<any>[];
    private verboseLogging: boolean;
    public utf8decoder: TextDecoder_Instance;
    public lineCount: number;
    private readonly file: File | null;

    constructor() {
        this.taskList = [];
        this.runningTask = null;
        this.queuedTaskList = [];
        this.verboseLogging = false;
        this.utf8decoder = new TextDecoder('utf-8');
        this.lineCount = 0;
        this.file = null;
        Object.defineProperties(this, {
            file: {
                writable: false
            },
            lineCount: {
                writable: false
            }
        });
        this.worker = new Worker('txt-reader-worker.js?i=' + new Date().getTime());
        this.worker.addEventListener('message', (event: IResponseMessageEvent) => {
            if (this.verboseLogging) {
                console.log('Main thread received a message from worker thread: \r\n', event.data);
            }
            if (this.runningTask === null) {
                return;
            }
            let response = event.data;
            if (response.taskId !== this.runningTask.id) {
                throw (`Received task ID (${response.taskId}) does not match the running task ID (${this.runningTask.id}).`);
            }
            if (response.done) {
                // the task completes
                this.completeTask(response);
            } else {
                // the task is incomplete, means it is a progress message
                if (Object.prototype.toString.call(response.result).toLowerCase() === '[object number]' && response.result >= 0 && response.result <= 100) {
                    this.runningTask.updateProgress(response.result);
                } else {
                    throw ('Unkown message type');
                }
            }
        }, false);
    }

    public sniffLines(file: File, lineNumber: number, decode: boolean = true): TxtReaderTask<ISniffLinesTaskResponse> {
        return this.newTask<ISniffLinesTaskResponse>('sniffLines', {
            file: file,
            lineNumber: lineNumber,
            decode: decode
        });
    }

    public loadFile(file: File, config?: IIteratorConfig): TxtReaderTask<ILoadFileTaskResponse> {
        Object.defineProperties(this, {
            file: {
                value: null
            },
            lineCount: {
                value: 0
            }
        });
        let data: any = {
            file: file
        };
        if (config) {
            data.config = this.getItertorConfigMessage(cloneDeep(config));
        }
        return this.newTask<ILoadFileTaskResponse>('loadFile', data).then((response) => {
            Object.defineProperties(this, {
                lineCount: {
                    value: response.result.lineCount
                },
                file: {
                    value: file
                }
            });
        });
    }

    public setChunkSize(chunkSize: number): TxtReaderTask<ISetChunkSizeResponse> {
        return this.newTask('setChunkSize', chunkSize);
    }

    public enableVerbose() {
        this.verboseLogging = true;
        return this.newTask('enableVerbose');
    }

    public getLines2(linesRanges: LinesRanges, decode: boolean = true): TxtReaderTask<IGetLines2TaskResponse> {
        if (!this.file) {
            return this.newTask<IGetLines2TaskResponse>('getLines2', new Error('TxtReader has not loaded a file yet.'));
        }
        console.log('getlines2', linesRanges);
        return this.newTask<IGetLines2TaskResponse>('getLines2', linesRanges).then((response) => {
        });

    }

    public getLines(start: number, count: number, decode: boolean = true): TxtReaderTask<IGetLinesTaskResponse> {
        if (!this.file) {
            return this.newTask<IGetLinesTaskResponse>('getLines', new Error('TxtReader has not loaded a file yet.'));
        }
        return this.newTask<IGetLinesTaskResponse>('getLines', { start: start, count: count }).then((response) => {
            for (let i = 0; i < response.result.length; i++) {
                if (decode) {
                    response.result[i] = this.utf8decoder.decode(response.result[i] as any as Uint8Array);
                }
            }
        });
    }

    public getSporadicLines(linesRanges: LinesRanges, decode: boolean = true): TxtReaderTask<IGetSporadicLinesTaskResponse> {
        return this.newTask<IGetSporadicLinesTaskResponse>('getSporadicLines', {
            linesRanges: linesRanges,
            decode: decode
        });
    }

    public iterateLines(config: IIteratorConfig, start?: number, count?: number): TxtReaderTask<IIterateLinesTaskResponse> {
        if (!this.file) {
            return this.newTask<IGetLinesTaskResponse>('getLines', new Error('TxtReader has not loaded a file yet.'));
        }
        return this.newTask<IIterateLinesTaskResponse>('iterateLines', {
            config: this.getItertorConfigMessage(cloneDeep(config)),
            start: start !== undefined ? start : null,
            count: count !== undefined ? count : null
        });
    }

    public iterateSporadicLines(config: IIteratorConfig, linesRanges: LinesRanges): TxtReaderTask<IIterateLinesTaskResponse> {
        return this.newTask<IIterateLinesTaskResponse>('iterateSporadicLines', {
            config: this.getItertorConfigMessage(cloneDeep(config)),
            lines: linesRanges
        });
    }

    private getItertorConfigMessage(config: IIteratorConfig): IIteratorConfigMessage {
        let functionMap: string[] = [];
        function functionToString(obj: any, entry: string): any {
            let path = entry;
            if (typeof obj === 'object') {
                for (let i in obj) {
                    let pathi = `${path}["${i}"]`;
                    if (typeof obj[i] === 'function') {
                        obj[i] = obj[i].toString();
                        functionMap.push(pathi);
                    } else if (typeof obj[i] === 'object') {
                        obj[i] = functionToString(obj[i], pathi);
                    }
                }
            }
            return obj;
        }
        return {
            eachLine: config.eachLine.toString(),
            scope: functionToString(config.scope, "") || {},
            functionMap: functionMap
        };
    }

    private newTask<T>(action: string, data?: any): TxtReaderTask<T> {
        let reqMsg: RequestMessage = new RequestMessage(action, data);
        let task: TxtReaderTask<T> = new TxtReaderTask<T>(this.newTaskId(), reqMsg, this);
        this.taskList.push(task);
        if (!this.runningTask) {
            this.runTask(task);
        } else {
            this.queuedTaskList.push(task);
            task.state = TxtReaderTaskState.Queued;
        }
        return task;
    }

    private completeTask(response: IResponseMessage) {
        if (this.runningTask) {
            this.runningTask.complete(response);
            this.runningTask = null;
            this.runNextTask();
        }
    }

    private runNextTask() {
        if (this.queuedTaskList.length) {
            this.runTask(this.queuedTaskList.shift()!);
        }
    }

    private runTask(task: TxtReaderTask<any>) {
        this.runningTask = task;
        if (Object.prototype.toString.call(task.requestMessage.data) !== '[object Error]') {
            this.worker.postMessage(task.requestMessage);
        } else {
            window.setTimeout(() => {
                let response: IResponseMessage = {
                    success: false,
                    message: (task.requestMessage.data as Error).message,
                    result: null,
                    done: true,
                    taskId: task.id
                };
                this.completeTask(response);
            }, 0);
        }
        task.run();
    }

    private newTaskId(): number {
        let taskListLength: number = this.taskList.length;
        if (taskListLength === 0) {
            return 1;
        } else {
            return this.taskList[taskListLength - 1].id + 1;
        }
    }
}