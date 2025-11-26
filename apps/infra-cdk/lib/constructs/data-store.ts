import { RemovalPolicy } from "aws-cdk-lib";
import {
  AttributeType,
  BillingMode,
  StreamViewType,
  Table,
} from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export interface DataStoreProps {
  stage: string;
}

export class DataStore extends Construct {
  public readonly table: Table;
  public readonly tableName: string;
  public readonly gsi1Name: string = "GSI1";
  public readonly streamArn?: string;
  public readonly stage: string;

  constructor(scope: Construct, id: string, props: DataStoreProps) {
    super(scope, id);

    this.stage = props.stage;

    this.table = new Table(this, `Table-${this.stage}`, {
      tableName: `swng-main-${this.stage}`,
      billingMode: BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      removalPolicy: RemovalPolicy.RETAIN,
      stream: StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: "ttl",
    });

    this.table.addGlobalSecondaryIndex({
      indexName: this.gsi1Name,
      partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: AttributeType.STRING },
    });

    this.tableName = this.table.tableName;
    this.streamArn = this.table.tableStreamArn;
  }
}
