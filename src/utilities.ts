import { ComplexType, DataType, DataTypeSymbol, EntityType, IStructuralType, MetadataStore } from 'breeze-client';
import { Edm, Edmx, oData } from 'ts-odatajs';

export interface InvokableEntry {
    config: Edm.Action | Edm.Function;
    namespace: string;
    url?: string;
}

export namespace Utilities {

    const dataTypeMap: { [key: string]: DataTypeSymbol } = {
        binary: DataType.Binary,
        bool: DataType.Boolean,
        date: DataType.DateTimeOffset,
        datetimeoffset: DataType.DateTimeOffset,
        decimal: DataType.Decimal,
        duration: DataType.Duration,
        // enumMember?
        float: DataType.Double,
        guid: DataType.Guid,
        int: DataType.Int64,
        string: DataType.String,
        single: DataType.Single,
        timeofday: DataType.TimeOfDay
    };

    export function getDataType(key: string): DataTypeSymbol {
        const dataType = dataTypeMap[key] || dataTypeMap.string;
        return dataType;
    }

    export function getEdmTypeFromTypeName(metadata: Edmx.Edmx, typeName: string): Edm.ComplexType | Edm.EntityType {
        const bindingTypeName = oData.utils.getCollectionType(typeName) || typeName;
        const entityType = oData.utils.lookupEntityType(bindingTypeName, metadata);
        const complexType = oData.utils.lookupComplexType(bindingTypeName, metadata);

        return entityType || complexType;
    }

    export function adaptComplexType(metadataStore: MetadataStore, complexType: Edm.ComplexType): ComplexType {
        return <ComplexType>adaptStructuralType(metadataStore, complexType);
    }

    export function adaptEntityType(metadataStore: MetadataStore, entityType: Edm.EntityType): EntityType {
        return <EntityType>adaptStructuralType(metadataStore, entityType);
    }

    export function adaptStructuralType(metadataStore: MetadataStore, structuralType: Edm.ComplexType | Edm.EntityType): IStructuralType {
        const result = metadataStore.getEntityType(structuralType.name, true);

        return result;
    }

    export function getFunctions(metadata: Edmx.Edmx, metadataStore: MetadataStore): InvokableEntry[] {
        let result = [];

        metadata.dataServices.schema.forEach(s => {
            const namespace = s.namespace;
            if (!s.function) {
                return;
            }

            const entries: InvokableEntry[] = s.function.map(c => {
                const entry: InvokableEntry = {
                    config: c,
                    namespace: namespace,
                    url: getInvokableUrl(metadata, metadataStore, c, namespace)
                };

                return entry;
            });

            result = result.concat(entries);
        });

        return result;
    }

    export function getActions(metadata: Edmx.Edmx, metadataStore: MetadataStore): InvokableEntry[] {
        let result = [];

        metadata.dataServices.schema.forEach(s => {
            const namespace = s.namespace;
            if (!s.action) {
                return;
            }

            const entries: InvokableEntry[] = s.action.map(c => {
                const entry: InvokableEntry = {
                    config: c,
                    namespace: namespace,
                    url: getInvokableUrl(metadata, metadataStore, c, namespace)
                };

                return entry;
            });

            result = result.concat(entries);
        });

        return result;
    }

    export function getInvokableUrl(metadata: Edmx.Edmx, metadataStore: MetadataStore,
        config: Edm.Function | Edm.Action, namespace: string): string {

        const isBound = Boolean(config.isBound);
        let boundPart = '';

        if (isBound) {
            const bindingParameter = config.parameter[0];
            const bindingEdmType = getEdmTypeFromTypeName(metadata, bindingParameter.type);
            const breezeType = adaptEntityType(metadataStore, bindingEdmType);

            if (breezeType) {
                boundPart = `${breezeType.defaultResourceName}/`;
            }
        }

        const url = `${boundPart}${namespace}.${config.name}`;

        return url;
    }
}
