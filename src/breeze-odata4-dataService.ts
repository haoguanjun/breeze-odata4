import {
    AutoGeneratedKeyType,
    ComplexType,
    config,
    core,
    DataProperty,
    DataService,
    DataServiceAdapter,
    DataServiceSaveContext,
    DataType,
    Entity,
    EntityAspect,
    EntityKey,
    EntityQuery,
    EntityType,
    JsonResultsAdapter,
    KeyMapping,
    MappingContext,
    MetadataStore,
    QueryResult,
    SaveBundle,
    SaveResult
} from 'breeze-client';
import { Batch, Edm, Edmx, oData } from 'ts-odatajs';

import { getJsonResultsAdapter } from './breeze-jsonResultsAdapter-factory';
import { ClassRegistry } from './class-registry';
import { ODataError } from './odata-error';

import { MetadataAdapter } from './adapters/metadata-adapter';
import { AnnotationAdapter } from './adapters/annotation-adapter';
import { NavigationAdapter } from './adapters/navigation-adapter';

import { AnnotationDecorator } from './decorators/annotation-decorator';
import { CustomDecorator } from './decorators/custom-decorator';
import { DisplayNameDecorator } from './decorators/display-name-decorator';
import { StoreGeneratedPatternDecorator } from './decorators/store-generated-pattern-decorator';
import { ValidatorDecorator } from './decorators/validator-decorator';
import {
    adaptStructuralType,
    getActions,
    getEdmTypeFromTypeName,
    getFunctions,
    InvokableEntry,
    lookupAction,
    lookupFunction
} from './utilities';

// Seems crazy, but this is the only way I can find to do the inheritance
export class ProxyDataService { }

Object.setPrototypeOf(ProxyDataService.prototype, config.getAdapter('dataService', 'WebApi').prototype);

export class OData4DataService extends ProxyDataService implements DataServiceAdapter {
    // I don't like this, but I'm not able to find a better way
    private innerAdapter: DataServiceAdapter = <DataServiceAdapter>config.getAdapterInstance('dataService', 'WebApi');

    private metadataAdapters: MetadataAdapter[] = [];

    private functions: InvokableEntry[] = [];
    private actions: InvokableEntry[] = [];

    public name = 'OData4';

    public headers = {
        'OData-Version': '4.0'
    };

    public metadata: Edmx.Edmx;

    public jsonResultsAdapter: JsonResultsAdapter = getJsonResultsAdapter();

    public static register() {
        config.registerAdapter('dataService', OData4DataService);
    }

    constructor() {
        super();
    }

    public _catchNoConnectionError(err: Error): any {
        return this.innerAdapter._catchNoConnectionError(err);
    }

    public _createChangeRequestInterceptor(saveContext: DataServiceSaveContext, saveBundle: SaveBundle): {
        getRequest: <T>(request: T, entity: Entity, index: number) => T;
        done: (requests: Object[]) => void;
    } {
        return this.innerAdapter._createChangeRequestInterceptor(saveContext, saveBundle);
    }

    public checkForRecomposition(interfaceInitializedArgs: { interfaceName: string; isDefault: boolean; }): void {
        this.innerAdapter.checkForRecomposition(interfaceInitializedArgs);
    }

    public initialize(): void {
        // TODO: Figure out why this doesn't work
        /*core.requireLib("odatajs", "Needed to support remote OData v4 services");*/
        this.fixODataFormats();

        ClassRegistry.MetadataAdapters.add(NavigationAdapter, AnnotationAdapter);
        ClassRegistry.AnnotationDecorators.add(StoreGeneratedPatternDecorator, DisplayNameDecorator, CustomDecorator, ValidatorDecorator);

        this.metadataAdapters = ClassRegistry.MetadataAdapters.get();
    }

    public getAbsoluteUrl(dataService: DataService, url: string): string {
        const serviceName = dataService.qualifyUrl('');
        // only prefix with serviceName if not already on the url
        let base = core.stringStartsWith(url, serviceName) ? '' : serviceName;
        // If no protocol, turn base into an absolute URI
        if (window && serviceName.startsWith('//')) {
            // no protocol; make it absolute
            const loc = window.location;
            base = `${loc.protocol}//${loc.host}${core.stringStartsWith(serviceName, '/') ? '' : '/'}${base}`;
        }

        return base + url;
    }

    public fetchMetadata(metadataStore: MetadataStore, dataService: DataService): Promise<Edmx.DataServices> {

        const associations = {};

        const serviceName = dataService.serviceName;
        const url = this.getAbsoluteUrl(dataService, '$metadata');

        return new Promise((resolve, reject) => {
            // OData.read(url,
            oData.read({
                requestUri: url,
                // headers: { 'Accept': 'application/json'}
                headers: { Accept: 'application/json;odata.metadata=full' }
            },
                (data: Edmx.Edmx, response: any) => {
                    // data.dataServices.schema is an array of schemas. with properties of
                    // entityContainer[], association[], entityType[], and namespace.
                    if (!data || !data.dataServices) {
                        const error = new Error(`Metadata query failed for: ${url}`);
                        return reject(error);
                    }

                    this.metadata = data;

                    const csdlMetadata = this.metadata.dataServices;

                    this.metadataAdapters.forEach(a => {
                        oData.utils.forEachSchema(csdlMetadata, a.adapt.bind(a))
                    });

                    // might have been fetched by another query
                    if (!metadataStore.hasMetadataFor(serviceName)) {
                        try {
                            metadataStore.importMetadata(csdlMetadata);
                        } catch (e) {
                            reject(new Error(`Metadata query failed for ${url}; Unable to process returned metadata: ${e.message}`));
                        }

                        metadataStore.addDataService(dataService);
                    }

                    this.actions = getActions(this.metadata, metadataStore);
                    this.functions = getFunctions(this.metadata, metadataStore);

                    resolve(csdlMetadata);

                },
                (error: Error) => {
                    const err = this.createError(error, url);
                    err.message = `Metadata query failed for: ${url}; ${(err.message || '')}`;
                    reject(err);
                },
                oData.metadataHandler
            );
        });
    }

    public executeQuery(mappingContext: MappingContext): Promise<QueryResult> {
        const query = mappingContext.query as EntityQuery;

        const request = this.getRequest(mappingContext);
        return new Promise<QueryResult>((resolve, reject) => {
            oData.request(request,
                (data: any, response: any) => {
                    let inlineCount: number;
                    let results: any;

                    if (data) {
                        // OData can return data['@odata.count'] as a string
                        inlineCount = Number(data['@odata.count']);
                        results = data.value;
                    }

                    resolve({ results: results, query: query, inlineCount: inlineCount, httpResponse: response });
                },
                (error: Object) => {
                    const err = this.createError(error, request.requestUri);
                    reject(err);
                }
            );
        });
    }

    public saveChanges(saveContext: DataServiceSaveContext, saveBundle: SaveBundle): Promise<SaveResult> {
        const adapter = saveContext.adapter = this;

        saveContext.routePrefix = this.getAbsoluteUrl(saveContext.dataService, '');
        const url = `${saveContext.routePrefix}$batch`;

        const requestData = this.createChangeRequests(saveContext, saveBundle);
        const tempKeys = saveContext.tempKeys;
        const contentKeys = saveContext.contentKeys;

        return new Promise<SaveResult>((resolve, reject) => {
            oData.request({
                requestUri: url,
                method: 'POST',
                data: requestData
            },
                (data: Batch.BatchResponse, response: any) => {
                    const entities: Entity[] = [];
                    const keyMappings: KeyMapping[] = [];
                    const saveResult: SaveResult = { entities: entities, keyMappings: keyMappings, XHR: null };
                    data.__batchResponses.forEach((br: Batch.ChangeResponseSet) => {
                        br.__changeResponses.forEach((cr: Batch.ChangeResponse | Batch.FailedResponse, index: number) => {
                            const chResponse = (<Batch.FailedResponse>cr).response || <Batch.ChangeResponse>cr;
                            const statusCode = chResponse.statusCode;
                            if ((!statusCode) || Number(statusCode) >= 400) {
                                const err = this.createError(cr, url);
                                reject(err);
                                return;
                            }

                            /**
                             * It seems that the `Content-ID` header is not being properly parsed out by the odatajs library.
                             * As a work around we can assume that each change response is numbered sequentially from 1,
                             * and infer the ID from the index in the br.__changeResponses array.
                             */
                            /*var contentId = cr.headers['Content-ID'];*/
                            const contentId = index + 1;

                            const rawEntity: Entity = chResponse.data;
                            if (rawEntity) {
                                const tempKey = tempKeys[contentId];
                                if (tempKey) {
                                    const entityType = tempKey.entityType;
                                    if (entityType.autoGeneratedKeyType !== AutoGeneratedKeyType.None) {
                                        const tempValue = tempKey.values[0];
                                        const realKey = entityType.getEntityKeyFromRawEntity(rawEntity, DataProperty.getRawValueFromServer);
                                        const keyMapping: KeyMapping = {
                                            entityTypeName: entityType.name,
                                            tempValue: tempValue,
                                            realValue: realKey.values[0]
                                        };
                                        keyMappings.push(keyMapping);
                                    }
                                }
                                entities.push(rawEntity);
                            } else {
                                const origEntity = contentKeys[contentId];
                                entities.push(origEntity);
                            }
                        });
                    });

                    /*if (defer._rejected) {
                        throw defer.promise.source.exception;
                    }*/

                    resolve(saveResult);
                }, err => {
                    const error = this.createError(err, url);
                    reject(error);
                }, oData.batch.batchHandler, undefined, this.metadata);
        });
    }

    private createChangeRequests(saveContext: DataServiceSaveContext, saveBundle: SaveBundle): Batch.BatchRequest {
        const changeRequestInterceptor = this._createChangeRequestInterceptor(saveContext, saveBundle);
        const changeRequests: Batch.ChangeRequest[] = [];
        const tempKeys: EntityKey[] = [];
        const contentKeys: Entity[] = [];
        const entityManager = saveContext.entityManager;
        const helper = entityManager.helper;
        let id = 0;
        const routePrefix = saveContext.routePrefix;

        saveBundle.entities.forEach((entity: Entity, index: number) => {
            const aspect = entity.entityAspect;
            id = id + 1; // we are deliberately skipping id=0 because Content-ID = 0 seems to be ignored.
            let request: Batch.ChangeRequest = {
                headers: { 'Content-ID': id.toString(), 'Content-Type': 'application/json;IEEE754Compatible=true' },
                requestUri: null,
                method: null
            };
            contentKeys[id] = entity;
            if (aspect.entityState.isAdded()) {
                const resourceName = saveContext.resourceName || entity.entityType.defaultResourceName;
                request.requestUri = routePrefix + entity.entityType.defaultResourceName;
                request.method = 'POST';
                request.data = helper.unwrapInstance(entity, this.transformValue);
                tempKeys[id] = aspect.getKey();
            } else if (aspect.entityState.isModified()) {
                this.updateDeleteMergeRequest(request, aspect, routePrefix);
                request.method = 'PATCH';
                request.data = helper.unwrapChangedValues(entity, entityManager.metadataStore, this.transformValue);
                // should be a PATCH/MERGE
            } else if (aspect.entityState.isDeleted()) {
                this.updateDeleteMergeRequest(request, aspect, routePrefix);
                request.method = 'DELETE';
            } else {
                return;
            }
            request = changeRequestInterceptor.getRequest(request, entity, index);
            changeRequests.push(request);
        });

        saveContext.contentKeys = contentKeys;
        saveContext.tempKeys = tempKeys;
        changeRequestInterceptor.done(changeRequests);

        const changeRequestSet: Batch.ChangeRequestSet[] = [
            {
                __changeRequests: changeRequests
            }
        ];

        const batchRequest: Batch.BatchRequest = {
            __batchRequests: changeRequestSet
        };

        return batchRequest;
    }

    // TODO: Refactor to a request factory
    private getRequest(mappingContext: MappingContext): {
        method: string;
        requestUri: string;
        data?: any;
        headers?: any;
    } {
        const query = mappingContext.query as EntityQuery;
        let method = 'GET';
        let request = { method: method, requestUri: this.getUrl(mappingContext) };

        if (!query.parameters) {
            return request;
        }

        method = query.parameters['$method'] || method;
        delete query.parameters['$method'];

        if (method === 'GET') {
            request = Object.assign({}, request, { requestUri: this.addQueryString(request.requestUri, query.parameters) });
        } else {
            const data = query.parameters['$data'] ? this.getData(mappingContext, query.parameters['$data']) : query.parameters
            request = Object.assign({}, request, { method: method, data: data });
        }

        return request;
    }

    // TODO: Refactor to a request factory
    private getData(mappingContext: MappingContext, data: any): any {
        if (!data) {
            return null;
        }

        if (!this.areValidPropertyNames(mappingContext.metadataStore, data)) {
            return data;
        }

        const helper = mappingContext.entityManager.helper;
        if (data.entityType || data.complexType) {
            return helper.unwrapInstance(data, null);
        }

        // check if action exists
        const config = this.getInvokableConfig((<EntityQuery>mappingContext.query).resourceName);
        const actionEntry = this.actions.find(e => e.config === config);

        if (!actionEntry) {
            return data;
        }

        const paramIndex = config.isBound ? 1 : 0;

        const param = config.parameter.find((p, idx) => {
            if (idx < paramIndex || p.type.startsWith('Edm.')) {
                return false;
            }

            return true;
        });

        if (!param) {
            return data;
        }

        const edmType = getEdmTypeFromTypeName(this.metadata, param.type);
        if (!edmType) {
            return data;
        }

        const structuralType = adaptStructuralType(mappingContext.metadataStore, edmType);

        if (structuralType instanceof EntityType) {
            data = (<EntityType>structuralType).createEntity(data);
            return helper.unwrapInstance(data, null);
        } else if (structuralType instanceof ComplexType) {
            data = (<ComplexType>structuralType).createInstance(data);
            return helper.unwrapInstance(data, null);
        }

        return data;
    }

    private areValidPropertyNames(metadataStore: MetadataStore, data: any): boolean {
        const props = Object.keys(data);

        const result = props.every(p => {
            const sp = metadataStore.namingConvention.clientPropertyNameToServer(p);
            const cp = metadataStore.namingConvention.serverPropertyNameToClient(sp);
            return p === cp;
        });

        return result;
    }

    private getInvokableConfig(url: string): Edm.Action | Edm.Function {
        const urlParts = url ? url.split('/') : [];

        const binding = urlParts[0];
        const invokableName = urlParts.pop().replace(/\([^\)]*\)/, '');

        const actionConfig = lookupAction(invokableName, this.metadata);
        const functionConfig = lookupFunction(invokableName, this.metadata);

        return actionConfig || functionConfig;
    }

    // TODO: Refactor to a request factory
    private getUrl(mappingContext: MappingContext): string {
        const query = mappingContext.query as EntityQuery;
        const url = this.getAbsoluteUrl(mappingContext.dataService, mappingContext.getUrl());

        return url;
    }

    // TODO: Refactor to a request factory
    private addQueryString(url: string, parameters: Object): string {
        // Add query params if .withParameters was used
        const queryString = this.toQueryString(parameters);
        if (!queryString) {
            return url;
        }

        const sep = url.indexOf('?') < 0 ? '?' : '&';
        url += sep + queryString;

        return url;
    }

    private transformValue(prop: DataProperty, val: any): any {
        // TODO: Split these into separate parsers
        if (prop.isUnmapped) {
            return undefined;
        }

        if (prop.dataType === DataType.DateTimeOffset) {
            // The datajs lib tries to treat client dateTimes that are defined as DateTimeOffset on the server differently
            // from other dateTimes. This fix compensates before the save.
            val = val && new Date(val.getTime() - (val.getTimezoneOffset() * 60000));
        } else if (prop.dataType.quoteJsonOData) {
            val = val != null ? val.toString() : val;
        }

        return val;
    }

    private updateDeleteMergeRequest(request: Batch.ChangeRequest, aspect: EntityAspect, routePrefix: string): void {
        let uriKey;
        const extraMetadata = aspect.extraMetadata;
        if (!extraMetadata) {
            uriKey = this.getUriKey(aspect);
            aspect.extraMetadata = {
                uriKey: uriKey
            }
        } else {
            uriKey = extraMetadata['uriKey'] || this.getUriKey(aspect);
            if (extraMetadata['etag']) {
                request.headers['If-Match'] = extraMetadata['etag'];
            }
        }
        request.requestUri =
            // use routePrefix if uriKey lacks protocol (i.e., relative uri)
            uriKey.indexOf('//') > 0 ? uriKey : routePrefix + uriKey;
    }

    private getUriKey(aspect: EntityAspect): string {
        const entityType = aspect.entity.entityType;
        const resourceName = entityType.defaultResourceName;
        const kps = entityType.keyProperties;

        const uriKeyValue = kps.length === 1
            ? this.fmtProperty(kps[0], aspect)
            : kps.map(kp => {
                return `${kp.nameOnServer}=${this.fmtProperty(kp, aspect)}`;
            });

        const uriKey = `${resourceName}(${uriKeyValue})`;

        return uriKey;
    }

    private fmtProperty(prop: DataProperty, aspect: EntityAspect): any {
        return prop.dataType.fmtOData(aspect.getPropertyValue(prop.name));
    }

    private createError(error: any, url: string): ODataError {
        // OData errors can have the message buried very deeply - and nonobviously
        // this code is tricky so be careful changing the response.body parsing.
        const result = new ODataError();
        const response = error && (<Batch.FailedResponse>error).response;
        if (!response) {
            // in case DataJS returns 'No handler for this data'
            result.message = error;
            result.statusText = error;
            return result;
        }

        result.message = response.statusText;
        result.statusText = response.statusText;
        result.status = Number(response.statusCode);

        // non std
        if (url) {
            result.url = url;
        }

        result.body = response.body;
        if (response.body) {
            let nextErr;
            try {
                let body = JSON.parse(response.body);
                result.body = body;
                // OData v3 logic
                if (body['odata.error']) {
                    body = body['odata.error'];
                }
                let msg = '';
                do {
                    nextErr = body.error || body.innererror;
                    if (!nextErr) {
                        msg = msg + this.getMessage(body);
                    }

                    nextErr = nextErr || body.internalexception;
                    body = nextErr || body;
                } while (nextErr);
                if (msg.length > 0) {
                    result.message = msg;
                }
            } catch (e) {

            }
        }

        this._catchNoConnectionError(result);

        return result;
    }

    private getMessage(body: any): string {
        const msg = body['message'] || body['Message'] || '';
        return ((typeof (msg) === 'string') ? msg : msg.value) + '; ';
    }

    private fixODataFormats() {
        DataType.Int64.fmtOData = fmtFloat;
        DataType.Decimal.fmtOData = fmtFloat;
        DataType.Double.fmtOData = fmtFloat;
        DataType.DateTime.fmtOData = fmtDateTime;
        DataType.DateTimeOffset.fmtOData = fmtDateTimeOffset;
        DataType.Time.fmtOData = fmtTime;
        DataType.Guid.fmtOData = fmtGuid;

        function fmtFloat(val: any): any {
            if (val === null) {
                return null;
            }

            if (typeof val === 'string') {
                val = parseFloat(val);
            }

            return val;
        }

        function fmtDateTime(val: any): any {
            if (!val) {
                return null;
            }

            try {
                return val.toISOString();
            } catch (e) {
                throwError('\'%1\' is not a valid dateTime', val);
            }
        }

        function fmtDateTimeOffset(val: any): any {
            if (!val) {
                return null;
            }

            try {
                return val.toISOString();
            } catch (e) {
                throwError('\'%1\' is not a valid dateTimeOffset', val);
            }
        }

        function fmtTime(val: any): any {
            if (!val) {
                return null;
            }

            if (!core.isDuration(val)) {
                throwError('\'%1\' is not a valid ISO 8601 duration', val);
            }

            return val;
        }

        function fmtGuid(val: any): any {
            if (!val) {
                return null;
            }

            if (!core.isGuid(val)) {
                throwError('\'%1\' is not a valid guid', val);
            }

            return val;
        }

        function throwError(msg: string, val: any): void {
            msg = core.formatString(msg, val);
            throw new Error(msg);
        }
    }

    private toQueryString(payload: {}): string {
        if (!payload) {
            return null;
        }

        const result = Object.keys(payload)
            .map(key => {
                return `${encodeURIComponent(key)}=${encodeURIComponent(payload[key])}`;
            })
            .join('&');

        return result;
    }
}
